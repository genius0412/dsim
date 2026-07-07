import type { Replay } from '../../src/sim/replay';
import type { RobotSpec } from '../../src/types';
import { q } from './pool';

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
}

export async function submitRecord(r: RecordSubmit): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into records (user_id, partner_id, mode, drivetrain, score, balance_version, replay_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [r.userId, r.partnerId ?? null, r.mode, r.drivetrain, r.score, r.balanceVersion, r.replayId],
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
         r.user_id, r.partner_id, r.score, r.replay_id, r.created_at
       from records r
       where r.balance_version = $1 and r.mode = $2 ${dtFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.user_id as "userId", p.handle, b.partner_id as "partnerId",
            b.score, b.replay_id as "replayId", b.created_at as "createdAt"
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

export async function upsertRating(
  userId: string,
  mode: '1v1' | '2v2',
  drivetrain: string,
  balanceVersion: number,
  rating: number,
): Promise<void> {
  await q(
    `insert into elo_ratings (user_id, mode, drivetrain, balance_version, rating, games)
     values ($1, $2, $3, $4, $5, 1)
     on conflict (user_id, mode, drivetrain, balance_version)
       do update set rating = excluded.rating, games = elo_ratings.games + 1, updated_at = now()`,
    [userId, mode, drivetrain, balanceVersion, rating],
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
