import type { Replay } from '../../src/sim/replay';
import type { AssistConfig, RobotSpec } from '../../src/types';
import { q } from './pool';

/** the robot configuration a record run used (denormalized onto the row) */
export interface RecordConfig {
  spec: RobotSpec;
  assists: AssistConfig;
}

/**
 * Data-access for Phase 3 (records, ELO, replays, presets, seasons). The SERVER
 * is the only trusted writer — scores come from the authoritative sim, never a
 * client POST. Every write is stamped with the replay's BALANCE_VERSION (the
 * season key). All calls no-op when the DB is disabled.
 */

// ------------------------------------------------------------- seasons ------
export async function ensureSeason(balanceVersion: number): Promise<void> {
  await q(
    `insert into seasons (balance_version, name, active) values ($1, $2, true)
     on conflict (balance_version) do update set active = true`,
    [balanceVersion, `Season ${balanceVersion}`],
  );
  await q(`update seasons set active = false where balance_version <> $1`, [balanceVersion]);
}

/**
 * The CURRENT season number. Season is the `balance_version` key, but the live
 * season is DB-controlled so an admin can start a fresh season at runtime WITHOUT
 * a code redeploy (`startNewSeason`). It is the greater of the highest season row
 * on record and the code's `BALANCE_VERSION` fallback — so a genuine balance bump
 * (config `BALANCE_VERSION`↑) still rolls the season automatically, and an admin
 * bump (a higher `seasons` row) wins when there's been no balance change.
 */
export async function currentSeasonNumber(fallback: number): Promise<number> {
  const rows = await q<{ bv: number | null }>(`select max(balance_version) as bv from seasons`);
  return Math.max(Number(rows[0]?.bv ?? 0), fallback);
}

export interface SeasonRow {
  season: number;
  name: string;
  active: boolean;
  startedAt: string;
  records: number;
  matches: number;
}

/** every season that exists (a `seasons` row OR any data stamped with it),
 * newest first, with how much data each holds. */
export async function listSeasons(): Promise<SeasonRow[]> {
  const rows = await q<{
    season: number;
    name: string | null;
    active: boolean | null;
    started_at: string | null;
    records: string;
    matches: string;
  }>(
    `with versions as (
       select balance_version as v from seasons
       union select balance_version from records
       union select balance_version from matches
     )
     select v.v as season,
            s.name as name,
            coalesce(s.active, false) as active,
            s.started_at as started_at,
            (select count(*) from records r where r.balance_version = v.v) as records,
            (select count(*) from matches m where m.balance_version = v.v) as matches
     from versions v
     left join seasons s on s.balance_version = v.v
     order by v.v desc`,
  );
  return rows.map((r) => ({
    season: r.season,
    name: r.name ?? `Season ${r.season}`,
    active: !!r.active,
    startedAt: r.started_at ?? '',
    records: Number(r.records),
    matches: Number(r.matches),
  }));
}

/** Archive the live season and open a fresh one (admin action). The new season
 * number is one past the current, so its boards start empty; old seasons stay
 * fully queryable. Returns the new season number. */
export async function startNewSeason(fallback: number, name?: string): Promise<number> {
  const next = (await currentSeasonNumber(fallback)) + 1;
  await q(
    `insert into seasons (balance_version, name, active) values ($1, $2, true)
     on conflict (balance_version) do update set name = excluded.name, active = true`,
    [next, name && name.trim() ? name.trim() : `Season ${next}`],
  );
  await q(`update seasons set active = false where balance_version <> $1`, [next]);
  return next;
}

/** Delete all replays stamped with a given (archived) season. The record/match
 * rows survive — their `replay_id` FK is `on delete set null`, so leaderboard
 * entries stay visible, they just stop being watchable. Returns the count freed. */
export async function purgeSeasonReplays(season: number): Promise<number> {
  const rows = await q<{ id: string }>(
    `delete from replays where balance_version = $1 returning id`,
    [season],
  );
  return rows.length;
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

/** a user's public profile (currently just the display handle), or null */
export async function getProfile(userId: string): Promise<{ userId: string; handle: string } | null> {
  const rows = await q<{ handle: string }>(`select handle from profiles where user_id = $1`, [userId]);
  return rows[0] ? { userId, handle: rows[0].handle } : null;
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
export async function saveReplay(replay: Replay): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into replays (format, balance_version, seed, ticks, setups, tracks)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      replay.format,
      replay.balanceVersion,
      replay.seed,
      replay.ticks,
      JSON.stringify(replay.setups),
      JSON.stringify(replay.tracks),
    ],
  );
  return rows[0].id;
}

export async function getReplay(id: string): Promise<Replay | null> {
  const rows = await q<{
    format: number;
    balance_version: number;
    seed: string;
    ticks: number;
    setups: Replay['setups'];
    tracks: Replay['tracks'];
  }>(`select format, balance_version, seed, ticks, setups, tracks from replays where id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    format: r.format,
    balanceVersion: r.balance_version,
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
}

export async function submitRecord(r: RecordSubmit): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into records (user_id, partner_id, mode, drivetrain, score, balance_version, replay_id, config)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      r.userId,
      r.partnerId ?? null,
      r.mode,
      r.drivetrain,
      r.score,
      r.balanceVersion,
      r.replayId,
      r.config ? JSON.stringify(r.config) : null,
    ],
  );
  return rows[0].id;
}

export interface BoardRow {
  userId: string;
  handle: string;
  partnerId: string | null;
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
}): Promise<BoardRow[]> {
  const params: unknown[] = [opts.balanceVersion, opts.mode];
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
       where r.balance_version = $1 and r.mode = $2 ${dtFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.user_id as "userId", p.handle, b.partner_id as "partnerId",
            b.score, b.replay_id as "replayId", b.created_at as "createdAt", b.config
     from best b join profiles p on p.user_id = b.user_id
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
): Promise<number | null> {
  const rows = await q<{ score: number | null }>(
    `select max(score) as score from records
     where user_id = $1 and mode = $2 and drivetrain = $3 and balance_version = $4`,
    [userId, mode, drivetrain, balanceVersion],
  );
  return rows[0]?.score ?? null;
}

/** the user's standing in a season × mode × drivetrain bucket, by their BEST
 * score there: 1-based `rank` (ties share the better rank) and the bucket's
 * player `total`. Call AFTER submitting the run so it reflects it. */
export async function recordRank(
  userId: string,
  mode: 'solo' | 'duo',
  drivetrain: string,
  balanceVersion: number,
): Promise<{ rank: number; total: number }> {
  const rows = await q<{ rank: number; total: number }>(
    `with best as (
       select user_id, max(score) as s from records
       where balance_version = $1 and mode = $2 and drivetrain = $3
       group by user_id
     ), me as (select s from best where user_id = $4)
     select
       (select count(*) from best)::int as total,
       (1 + (select count(*) from best where s > (select s from me)))::int as rank`,
    [balanceVersion, mode, drivetrain, userId],
  );
  return { rank: rows[0]?.rank ?? 1, total: rows[0]?.total ?? 1 };
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
export async function getRating(
  userId: string,
  mode: '1v1' | '2v2',
  drivetrain: string,
  balanceVersion: number,
): Promise<number> {
  const rows = await q<{ rating: number }>(
    `select rating from elo_ratings
     where user_id = $1 and mode = $2 and drivetrain = $3 and balance_version = $4`,
    [userId, mode, drivetrain, balanceVersion],
  );
  return rows[0]?.rating ?? 1000;
}

/** the full Glicko-2 state (rating + deviation + volatility). Defaults are a
 * fresh, maximally-uncertain player: 1000 / RD 350 / vol 0.06. */
export async function getRatingFull(
  userId: string,
  mode: '1v1' | '2v2',
  drivetrain: string,
  balanceVersion: number,
): Promise<{ rating: number; rd: number; vol: number }> {
  const rows = await q<{ rating: number; rd: number; vol: number }>(
    `select rating, rd, vol from elo_ratings
     where user_id = $1 and mode = $2 and drivetrain = $3 and balance_version = $4`,
    [userId, mode, drivetrain, balanceVersion],
  );
  const r = rows[0];
  return { rating: r?.rating ?? 1000, rd: r?.rd ?? 350, vol: r?.vol ?? 0.06 };
}

export async function upsertRating(
  userId: string,
  mode: '1v1' | '2v2',
  drivetrain: string,
  balanceVersion: number,
  rating: number,
  rd: number,
  vol: number,
): Promise<void> {
  await q(
    `insert into elo_ratings (user_id, mode, drivetrain, balance_version, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, 1)
     on conflict (user_id, mode, drivetrain, balance_version)
       do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
                     games = elo_ratings.games + 1, updated_at = now()`,
    [userId, mode, drivetrain, balanceVersion, Math.round(rating), rd, vol],
  );
}

export async function eloLeaderboard(opts: {
  mode: '1v1' | '2v2';
  drivetrain: string;
  balanceVersion: number;
  limit?: number;
}): Promise<{ userId: string; handle: string; rating: number; games: number }[]> {
  return q<{ userId: string; handle: string; rating: number; games: number }>(
    `select e.user_id as "userId", p.handle, e.rating, e.games
     from elo_ratings e join profiles p on p.user_id = e.user_id
     where e.balance_version = $1 and e.mode = $2 and e.drivetrain = $3
     order by e.rating desc, e.games desc
     limit $4`,
    [opts.balanceVersion, opts.mode, opts.drivetrain, opts.limit ?? 100],
  );
}

// -------------------------------------------------------- global stats -----
export interface GlobalStats {
  users: number;
  games: number;
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number };
}

/** site-wide totals for the homepage: registered players + games played, split
 * by category (solo/duo record runs + 1v1/2v2 PvP matches — the server-tracked
 * games). Cheap COUNT/GROUP BY over indexed tables. Zeros when the DB is off. */
export async function getGlobalStats(): Promise<GlobalStats> {
  const [users, recRows, matchRows] = await Promise.all([
    q<{ n: string }>(`select count(*) as n from profiles`),
    q<{ mode: string; n: string }>(`select mode, count(*) as n from records group by mode`),
    q<{ mode: string; n: string }>(`select mode, count(*) as n from matches group by mode`),
  ]);
  const byCategory: GlobalStats['byCategory'] = { solo: 0, duo: 0, '1v1': 0, '2v2': 0 };
  for (const r of [...recRows, ...matchRows]) {
    if (r.mode in byCategory) byCategory[r.mode as keyof GlobalStats['byCategory']] = Number(r.n);
  }
  const games = byCategory.solo + byCategory.duo + byCategory['1v1'] + byCategory['2v2'];
  return { users: Number(users[0]?.n ?? 0), games, byCategory };
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
export async function getUserStats(userId: string, balanceVersion: number): Promise<UserStats> {
  const [profile, elo, recPb, recRank, match, recent] = await Promise.all([
    q<{ handle: string }>(`select handle from profiles where user_id = $1`, [userId]),
    q<{ mode: '1v1' | '2v2'; rating: number; games: number; rnk: string }>(
      `with ranked as (
         select user_id, mode, rating, games,
                rank() over (partition by mode order by rating desc, games desc) as rnk
         from elo_ratings
         where balance_version = $1 and drivetrain = 'overall'
       )
       select mode, rating, games, rnk from ranked where user_id = $2`,
      [balanceVersion, userId],
    ),
    q<{ mode: 'solo' | 'duo'; score: number; replay_id: string | null }>(
      `select distinct on (mode) mode, score, replay_id
       from records where user_id = $1 and balance_version = $2
       order by mode, score desc, created_at asc`,
      [userId, balanceVersion],
    ),
    q<{ mode: 'solo' | 'duo'; rnk: string }>(
      `with best as (
         select user_id, mode, max(score) as score
         from records where balance_version = $1 group by user_id, mode
       ), ranked as (
         select user_id, mode, rank() over (partition by mode order by score desc) as rnk
         from best
       )
       select mode, rnk from ranked where user_id = $2`,
      [balanceVersion, userId],
    ),
    q<{ played: string; wins: string }>(
      `select count(*) as played, count(*) filter (where mp.won) as wins
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2`,
      [userId, balanceVersion],
    ),
    q<UserMatchRow>(
      `select mp.match_id as "matchId", m.mode, mp.alliance, mp.score, mp.won,
              mp.rating_before as "ratingBefore", mp.rating_after as "ratingAfter",
              m.created_at as "createdAt"
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2
       order by m.created_at desc limit 10`,
      [userId, balanceVersion],
    ),
  ]);

  const rankByMode = new Map(recRank.map((r) => [r.mode, Number(r.rnk)]));
  const elos: UserEloStat[] = (['1v1', '2v2'] as const).map((mode) => {
    const row = elo.find((e) => e.mode === mode);
    const ranked = elo.find((e) => e.mode === mode);
    return {
      mode,
      rating: row ? row.rating : 1000,
      games: row ? row.games : 0,
      rank: ranked ? Number(ranked.rnk) : null,
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
): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into matches (mode, balance_version, replay_id) values ($1, $2, $3) returning id`,
    [mode, balanceVersion, replayId],
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
  ratingBefore: number;
  ratingAfter: number;
}): Promise<void> {
  await q(
    `insert into match_participants
       (match_id, user_id, alliance, drivetrain, score, won, rating_before, rating_after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (match_id, user_id) do nothing`,
    [p.matchId, p.userId, p.alliance, p.drivetrain, p.score, p.won, p.ratingBefore, p.ratingAfter],
  );
}
