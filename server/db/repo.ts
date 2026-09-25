import type { Replay } from '../../src/sim/replay';
import type { AssistConfig, GameId, RobotSpec } from '../../src/types';
import type { PendingMatch, PendingRosterEntry } from '../matchTypes';
import { BALANCE_VERSION, PLACEMENT_GAMES } from '../../src/config';
import { awardKey } from '../../src/awards';
import {
  isBadgeId,
  MAX_EQUIPPED_BADGES,
  podiumBadge,
  withBadgeEquipped,
  type EquippedBadge,
} from '../../src/badges';
import type { RecordPlacement, RewardItem, RewardReason, RewardSource } from '../../src/rewards';
import { coerceGameId, GAME_IDS, serverPhysics } from '../../src/games/types';
import { simModuleFor } from '../../src/games/sim';
import { COSMETIC_AXES } from '../../src/cosmetics';
import {
  STANDING_MAX, HEAL_PER_DAY, HEAL_PER_CLEAN_MATCH, clampScore, type StandingVerdict,
} from '../../src/standing';
import { dbEnabled, q, tx, type Tx } from './pool';
import {
  ACCESS_GROUPS,
  BANNER_KINDS,
  type AccessGroup,
  type BannerKind,
  type LockdownScope,
} from '../../src/net/protocol';
import { scrubSpecNames } from '../moderation';

/** every board/period is keyed by game; old callers/rows default to DECODE. */
type Game = GameId;
const g = (game?: Game): Game => game ?? 'decode';

/**
 * WHICH ERA A BOARD READ OF THIS GAME MEANS — the record board's half of the owner's ruling
 * (2026-09-18): runs set on the 2D physics and on the 3D physics do NOT share a record board,
 * because every server-connected match of a 3D-capable game is 3D (`serverPhysics`).
 *
 * `'3d'` for such a game, `undefined` (no filter at all) for a one-solve game, whose rows are
 * all `'2d'` anyway — so DECODE's and Chain Reaction's queries keep the exact SQL they had.
 *
 * ⚠️ **DECIDED HERE, NOT BY THE CALLER.** It used to ride in as an optional `physics` argument
 * that `/api/records` filled from a QUERY PARAMETER, which means the board a client saw was
 * the board it asked for — and every path that forgot to ask (a personal best, a career panel,
 * a profile page) silently read both eras. A default in the data layer is the only version of
 * this rule that a new call site cannot miss.
 *
 * The pre-0039 rows are NOT deleted: a 2D BIOBUZZ run keeps its row, its replay and its place
 * in the player's own match history. It simply stops being ranked against 3D runs.
 *
 * ⚠️ **THE ERA IS A PROPERTY OF THE SEASON, NOT OF THE GAME** (owner, 2026-09-24). The LIVE
 * season is always the game's live solve (`livePhysics`), because that is the only solve a new
 * record can be written in. An ARCHIVED season is the solve its runs were played on: BIOBUZZ
 * Act 1 was a 2D season, and reading it as `'3d'` emptied its board and paid its record awards
 * to nobody. "Played on" is the era holding most of the season's rows, so the handful of 3D
 * runs a season picks up between a deploy and the roll that closes it cannot take the board
 * over. Still one era per board, and every reader still goes through here.
 */
function livePhysics(game: Game): '3d' | undefined {
  return serverPhysics(simModuleFor(game)) === '3d' ? '3d' : undefined;
}

/** which era the board of `game` × `balanceVersion` is made of — see above. `current` saves the
 *  lookup for a caller that already knows the live season. */
export async function boardPhysics(
  game: Game,
  balanceVersion: number,
  current?: number,
): Promise<'2d' | '3d' | undefined> {
  const live = livePhysics(game);
  if (!live) return undefined;
  const cur = current ?? (await currentSeasonNumber(BALANCE_VERSION, game));
  if (balanceVersion >= cur) return live;
  const rows = await q<{ physics: string }>(
    `select physics from records where game = $1 and balance_version = $2
     group by physics order by count(*) desc, physics desc limit 1`,
    [game, balanceVersion],
  );
  return rows[0]?.physics === '2d' ? '2d' : live;
}

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
/**
 * (game, balanceVersion) pairs this process has already seeded. `ensureSeason` is
 * two WRITES, and `GET /api/seasons` - the leaderboard's season picker, hit on
 * every visit to Records - ran it on every request. In production that made
 * `seasons` the second busiest table in the whole database (121k updates against
 * 8 inserts), all of it re-asserting a row that was already correct.
 *
 * Memoizing is safe precisely because the key IS the season: when an admin rolls a
 * new one, `currentSeasonNumber` returns the new number, which is a new key, so
 * the seed-and-deactivate runs again exactly when it has something to do.
 */
const seasonEnsured = new Set<string>();

export async function ensureSeason(
  balanceVersion: number,
  game?: Game,
  initialAct = 0,
): Promise<void> {
  const key = `${g(game)}:${balanceVersion}`;
  if (seasonEnsured.has(key)) return;
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
  seasonEnsured.add(key);
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
  const closing = await currentSeasonNumber(fallback, game);
  const next = closing + 1;
  const cur = await q<{ act: number | null }>(
    `select act from seasons where game = $1 order by balance_version desc limit 1`,
    [g(game)],
  );
  const closingAct = Number(cur[0]?.act ?? 0);
  const act = closingAct + (bumpAct ? 1 : 0);
  const custom = name && name.trim() ? name.trim() : null;

  /**
   * ONE TRANSACTION for the roll itself: insert the new season, deactivate the rest, count.
   * `q()` takes a connection PER CALL (`pool.ts`), so the four statements this used to be
   * could leave a half-rolled season behind.
   */
  const seasonNo = await tx(async (query) => {
    await query(
      `insert into seasons (game, balance_version, name, act, active) values ($1, $2, $3, $4, true)
       on conflict (game, balance_version) do update set name = excluded.name, act = excluded.act, active = true`,
      [g(game), next, custom, act],
    );
    await query(`update seasons set active = false where game = $1 and balance_version <> $2`, [g(game), next]);
    const cnt = await query<{ n: number }>(
      `select count(*)::int as n from seasons where game = $1 and act = $2`,
      [g(game), act],
    );
    return Number(cnt[0]?.n ?? 1);
  });

  /**
   * THE CLOSED PERIODS ARE PAID OUT NOW, BY THE SAME JOB THE BOOT BACKFILL RUNS
   * (`runRewardJob`). It used to be a separate award write inside the roll's transaction
   * (0045's `season_awards`), which had one real hazard: a roll whose award step failed left
   * the closed season un-awarded forever, because the next attempt read "the closing season"
   * off a table that had already moved on. The job instead asks which periods are CLOSED and
   * not yet paid (`reward_periods`), so a failure here is picked up by the next boot on any
   * machine, and a repeated roll pays nothing twice.
   *
   * AFTER the commit, deliberately: the job reads the boards of the periods the roll just
   * closed, and "closed" is defined by the `seasons` rows the transaction above wrote.
   * ⚠️ It can never fail the roll — the season has moved on either way, and the job is
   * idempotent, so the worst case of a throw here is that the reward arrives at next boot.
   */
  try {
    const paid = await runRewardJob({ games: [g(game)], fallback });
    if (paid.grants) console.log(`[rewards] roll paid ${paid.grants} grant(s) over ${paid.periods} period(s)`);
  } catch (e) {
    console.error('[rewards] the award job after a season roll failed; the next boot retries it:', e);
  }
  return { season: next, act, seasonNo };
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

/**
 * Users whose profile row this process has already created. The insert below is
 * `on conflict do nothing` and deliberately never touches `handle` (renames go
 * through `setHandle`), so once it has succeeded for a user it can never do
 * anything again - which makes skipping it exactly equivalent, not merely cheaper.
 *
 * Worth memoizing because `/api/friends` calls this on EVERY poll and a signed-in
 * player polls every 6s: a third of the queries on the busiest authenticated path
 * were provably no-ops. Bounded by the distinct users a machine sees before it
 * auto-stops; a restart simply re-learns them.
 */
const profileEnsured = new Set<string>();

export async function ensureProfile(userId: string, handle: string): Promise<void> {
  if (profileEnsured.has(userId)) return;
  await q(
    `insert into profiles (user_id, handle) values ($1, $2)
     on conflict (user_id) do nothing`,
    [userId, handle],
  );
  profileEnsured.add(userId);
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
  /**
   * active supporter membership — drives the badge.
   *
   * OPTIONAL because a caller may not have asked for it, and because a client
   * talking to a server older than the feature will not receive it at all. Both
   * cases mean "not asked", which renders identically to false — never as a
   * missing field somewhere upstream.
   */
  supporter?: boolean;
  /**
   * 'owner' | 'admin' for staff, absent otherwise — drives the staff badge.
   *
   * Optional for the same reason `supporter` is. `undefined` means "not asked"
   * and renders as no badge, identically to a null role.
   */
  role?: StaffRole;
  /** the EQUIPPED BADGES and their counters (`profiles.equipped_badges`, 0048). Optional on
   *  the same "not asked / older server" terms as `supporter`/`role`. */
  badges?: EquippedBadge[];
  /**
   * EARNED, PERMANENT cosmetic unlocks (`profiles.cosmetics`, migration 0044) — `"<axis>:<key>"`
   * ids, `src/cosmetics.ts`. Separate ledger from `supporter`: these survive a lapsed
   * membership, so the server's entitlement strip (`server/index.ts`/`server/room.ts`, run
   * after `coerceSpec`) reads both rather than either alone. Optional for the same "not asked
   * / older server" reason as `supporter`/`role`.
   */
  cosmetics?: string[];
}

/** who runs the service. Projected from `ADMIN_USER_IDS` / `OWNER_USER_ID` into
 *  `profiles.role` at boot — see 0020_staff_roles.sql for why it is a column. */
export type StaffRole = 'owner' | 'admin';

/** is this row staff? Shared so "staff" means one thing in every query.
 *  `a` qualifies the column for a joined query — `staffPred('pp.')`. */
const staffPred = (a = ''): string => `${a}role in ('owner', 'admin')`;
const STAFF_PRED = staffPred();

/** narrow whatever the column holds. A value outside the check constraint could
 *  only come from a hand-edited row, and reads as no role. */
export const asRole = (v: unknown): StaffRole | undefined =>
  v === 'owner' || v === 'admin' ? v : undefined;

/**
 * The badge/perk predicate, written once. `supporter_until` is an instant, and the
 * comparison must happen in Postgres — the five regional machines do not share a
 * clock, and a skewed one would show a badge that has already lapsed.
 *
 * STAFF COUNT AS SUPPORTERS, and this expression is the only place that says so.
 * Every perk — no ads, the cosmetic robot fill, the entitlements endpoint — is
 * derived from it, so folding the role in here grants all of them at once and
 * makes it impossible for one surface to disagree with another about whether an
 * admin is entitled.
 */
const supporterPred = (a = ''): string =>
  `((${a}supporter_until is not null and ${a}supporter_until > now()) or ${staffPred(a)})`;
const SUPPORTER_COL = `${supporterPred()} as supporter`;

/**
 * The two badge columns for a JOINED `profiles` row — `badgeCols('p.')`.
 *
 * Every surface that prints a name prints the badge beside it, so every query
 * behind such a surface needs the same two columns, and writing them out by hand
 * is how a board ends up quietly badge-less (which is exactly what happened to
 * the ranked board while the record board had them). `prefix` names a SECOND
 * person in the same row — a duo partner — as `partnerRole`/`partnerSupporter`.
 *
 * `coalesce(..., false)` matters on a LEFT JOIN: a solo run has no partner row,
 * and the predicate over all-NULL columns is NULL, not false.
 */
function badgeCols(a: string, prefix?: string): string {
  const role = prefix ? `"${prefix}Role"` : 'role';
  const sup = prefix ? `"${prefix}Supporter"` : 'supporter';
  const badges = prefix ? `"${prefix}Badges"` : 'badges';
  /**
   * ⚠️ THE EQUIPPED BADGES RIDE ALONG, WITH THEIR COUNTERS (0048), AND COST NOTHING EXTRA.
   * It is one more column off a `profiles` row this query has already joined:
   * `profiles.equipped_badges` is a PROJECTION of the reward ledger kept current by
   * `refreshEquippedBadges`, so a board row carries `[{id, n}]` without aggregating
   * `reward_grants` once per name. (The equipped TITLE rode here too until titles folded
   * into badges, 0049.)
   */
  return `${a}role as ${role}, coalesce(${supporterPred(a)}, false) as ${sup}, ${a}equipped_badges as ${badges}`;
}

/**
 * Reconcile `profiles.role` with the environment. Called once per boot, after
 * migrations.
 *
 * The env is the source of truth and this is a projection of it, so the sweep
 * must be SYMMETRIC: an id removed from `ADMIN_USER_IDS` has to lose the badge
 * and the perks, not keep them because nothing ever cleared the row. All five
 * machines run this on boot with the same input, so it is idempotent and
 * order-independent, and it only touches rows whose role is actually wrong.
 *
 * A staff id with no profile row yet is simply not updated; they pick up the role
 * on the next boot after they first sign in (`ensureProfile`), which is soon
 * enough for a badge.
 */
export async function syncStaffRoles(ownerId: string | null, adminIds: string[]): Promise<void> {
  const owner = ownerId && ownerId.trim() ? ownerId.trim() : null;
  // the owner is never also a plain admin — one row, one role
  const admins = [...new Set(adminIds.map((s) => s.trim()).filter((s) => s && s !== owner))];
  const want = `case
      when user_id = $1 then 'owner'
      when user_id = any($2::text[]) then 'admin'
      else null
    end`;
  await q(
    `update profiles set role = ${want}, updated_at = now()
      where role is distinct from (${want})`,
    [owner, admins],
  );
}

/** the staff among `userIds`, as id → role. The parallel of `supportersAmong`,
 *  for badges on a board or roster that was assembled in Node rather than by one
 *  query that could just join `profiles`. */
export async function staffAmong(userIds: string[]): Promise<Map<string, StaffRole>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await q<{ user_id: string; role: string }>(
    `select user_id, role from profiles where user_id = any($1::text[]) and ${STAFF_PRED}`,
    [ids],
  );
  const out = new Map<string, StaffRole>();
  for (const r of rows) {
    const role = asRole(r.role);
    if (role) out.set(r.user_id, role);
  }
  return out;
}

/** a user's public profile (display handle + unique username), or null. Also carries
 *  `cosmetics` (earned unlocks) — the ONE query the room join and the ranked queue path
 *  already make for the supporter/role badge, so the entitlement strip's "earned" set
 *  rides along for free rather than costing a second round trip. */
export async function getProfile(userId: string): Promise<PublicProfile | null> {
  const rows = await q<{
    handle: string;
    username: string | null;
    supporter: boolean;
    role: string | null;
    cosmetics: string[];
    equipped_badges: unknown;
  }>(
    // the equipped badges (0048) ride along for the reason `badgeCols` gives: this is the one
    // profile read the room join already makes, and a roster that shows the status disc but
    // not the badges reads as the badges having been lost
    `select handle, username, role, cosmetics, equipped_badges, ${SUPPORTER_COL} from profiles where user_id = $1`,
    [userId],
  );
  return rows[0]
    ? {
        userId,
        handle: rows[0].handle,
        username: rows[0].username,
        supporter: !!rows[0].supporter,
        role: asRole(rows[0].role),
        badges: asEquipped(rows[0].equipped_badges),
        cosmetics: rows[0].cosmetics ?? [],
      }
    : null;
}

/**
 * Neon Auth's OWN record of whether this account's address is verified — the row the
 * verification code flips. The email gate's source of truth when the JWT does not carry
 * the claim (server/auth.ts).
 *
 * It can read it because Neon Auth keeps its tables in THIS database, in the
 * `neon_auth` schema (`user`, `session`, `verification`, …; seen 2026-09-25). That is a
 * managed schema we do not migrate, so every failure — no DB, no schema, a renamed
 * column, an id that is not a uuid — answers null ("not told"), which the gate passes.
 */
export async function authEmailVerified(userId: string): Promise<boolean | null> {
  if (!dbEnabled) return null;
  try {
    const rows = await q<{ v: unknown }>(
      `select "emailVerified" as v from neon_auth."user" where id = $1`,
      [userId],
    );
    const v = rows[0]?.v;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/** resolve a public username → profile (the /profile/<username> read path), or null */
export async function getProfileByUsername(username: string): Promise<PublicProfile | null> {
  const rows = await q<{
    user_id: string;
    handle: string;
    username: string | null;
    supporter: boolean;
    role: string | null;
  }>(
    `select user_id, handle, username, role, ${SUPPORTER_COL} from profiles where username = $1`,
    [username],
  );
  const r = rows[0];
  return r
    ? {
        userId: r.user_id,
        handle: r.handle,
        username: r.username,
        supporter: !!r.supporter,
        role: asRole(r.role),
      }
    : null;
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

/**
 * TAKE AN ABUSIVE @USERNAME AWAY. Returns the one that was cleared, or null if there was none.
 *
 * ⚠️ CLEARED, NOT REPLACED, and that is the whole design. `user.rename` forces a clean DISPLAY
 * name, which is the one a player can change back the moment the moderator looks away — the
 * @username is the permanent, unique, public one, and nothing in the console could touch it.
 * A "set the username" control would have a moderator choosing somebody's permanent handle for
 * them, and would have to answer what happens when the name they pick is taken. Clearing the
 * column puts the account straight back through `UsernameGate`, which already validates the
 * format, checks uniqueness and runs the same content moderation the first claim did.
 *
 * `username` is nullable and its unique index admits any number of nulls, so this can never
 * collide. `updated_at` moves with it, as it does on every other write to this row.
 */
export async function clearUsername(userId: string): Promise<string | null> {
  // The CTE captures the OLD name in the statement's own snapshot, so the update and the
  // read of what it replaced are one statement: the audit row cannot end up saying `null`
  // because a second moderator cleared it a moment earlier.
  const rows = await q<{ username: string | null }>(
    `with old as (select username from profiles where user_id = $1)
     update profiles set username = null, updated_at = now()
      where user_id = $1 and username is not null
      returning (select username from old) as username`,
    [userId],
  );
  return rows.length > 0 ? (rows[0].username ?? null) : null;
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

// ---------------------------------------------- supporter entitlements ------
/**
 * Supporter membership, backed by Ko-fi. See 0018_supporter.sql for why this is
 * an expiry INSTANT on `profiles` rather than a boolean or a separate table.
 *
 * Every read compares against `now()` IN POSTGRES rather than in Node: the five
 * regional machines do not share a clock, and a skewed one would otherwise grant
 * or revoke a membership early.
 */
export interface SupporterState {
  supporter: boolean;
  supporterUntil: string | null;
  /** a Ko-fi payer address is linked, so payments renew without a manual claim */
  autoRenews: boolean;
  /** staff get the perks without paying — `supporter` is true with no expiry, and
   *  this is what lets the UI say "included with your role" rather than render a
   *  membership that appears to have already run out */
  role?: StaffRole;
}

const NOT_A_SUPPORTER: SupporterState = {
  supporter: false,
  supporterUntil: null,
  autoRenews: false,
};

export async function getSupporter(userId: string): Promise<SupporterState> {
  const rows = await q<{
    until: string | null;
    active: boolean;
    linked: boolean;
    role: string | null;
  }>(
    // `active` folds in the role deliberately: this is what the ad gate and the
    // cosmetics read, so staff must come back entitled here exactly as they do in
    // every badge query. `until` stays the REAL paid expiry (null for staff who
    // never paid) — conflating the two would show an admin a membership date they
    // do not have.
    `select supporter_until as until, role,
            ((supporter_until is not null and supporter_until > now()) or ${STAFF_PRED}) as active,
            (kofi_email is not null) as linked
       from profiles where user_id = $1`,
    [userId],
  );
  if (!rows[0]) return NOT_A_SUPPORTER;
  return {
    supporter: !!rows[0].active,
    supporterUntil: rows[0].until,
    autoRenews: !!rows[0].linked,
    role: asRole(rows[0].role),
  };
}

/** the currently-active supporters among `userIds` — one query, for badges on a
 *  leaderboard page or an in-match roster (a per-row lookup would not do). */
export async function supportersAmong(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await q<{ user_id: string }>(
    // staff are entitled without paying — same rule as SUPPORTER_COL, or a roster
    // would badge an admin on the leaderboard and not in the lobby
    `select user_id from profiles
      where user_id = any($1::text[]) and (supporter_until > now() or ${STAFF_PRED})`,
    [ids],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** the SQL that extends a membership. Shared by every grant path so the
 *  extend-don't-overwrite rule can only ever be written once.
 *
 *  EXTENDS rather than overwrites: `greatest(supporter_until, now())` means a
 *  renewal that arrives before the current period ends stacks on the remaining
 *  time instead of silently truncating it to one month from today. Someone who
 *  pays for a year up front, or whose renewal fires a day early, does not lose
 *  what they already bought. */
const EXTEND_SQL = `update profiles
     set supporter_until = greatest(coalesce(supporter_until, now()), now())
                           + ($2 || ' months')::interval,
         updated_at = now()
   where user_id = $1
   returning supporter_until as until`;

/** where a change to `supporter_until` came from — recorded in supporter_grants */
export type GrantSource = 'kofi' | 'admin' | 'revoke' | 'boost';

/**
 * Extend a membership by `months` and write the audit row.
 *
 * Two things can now move `supporter_until` — a Ko-fi payment and an admin — so
 * "why does this account have a membership?" stops being answerable from the
 * profile alone. Every write lands in `supporter_grants` with its source, which
 * is what makes a chargeback investigation possible after the fact.
 */
export async function grantSupporter(
  userId: string,
  months: number,
  source: GrantSource = 'admin',
  note?: string,
): Promise<string | null> {
  const n = Math.max(1, Math.floor(months));
  const rows = await q<{ until: string }>(EXTEND_SQL, [userId, String(n)]);
  const until = rows[0]?.until ?? null;
  if (rows[0]) await logGrant(userId, source, n, until, note ?? null);
  return until;
}

/**
 * End a membership immediately — a chargeback, a refund, or a mistaken comp.
 *
 * Clears the instant rather than winding it back, because there is no honest
 * "before" to restore to: a revoked membership is revoked, and if some of it was
 * legitimately paid for the correct remedy is a fresh admin grant for the part
 * that was. Returns false if there was nothing to revoke.
 */
export async function revokeSupporter(userId: string, note?: string): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `update profiles set supporter_until = null, updated_at = now()
      where user_id = $1 and supporter_until is not null
      returning user_id`,
    [userId],
  );
  if (rows.length === 0) return false;
  await logGrant(userId, 'revoke', 0, null, note ?? null);
  return true;
}

/**
 * THE DISCORD BOOST FLOOR — push `supporter_until` to at least `days` from now.
 *
 * ⚠️ **IT MUST NOT GO THROUGH `EXTEND_SQL`, AND THIS IS THE SINGLE MOST EXPENSIVE MISTAKE
 * AVAILABLE IN THE REWARDS WORK.** That statement ADDS MONTHS. An hourly sweep through it
 * would mint a decade of membership inside a year and nothing in the system could expire it
 * — `supporter_until` is the one predicate behind the badge, ads-off, the saved-start cap
 * and the palette, so it would be an unrevokable entitlement handed out by a cron. This sets
 * a FLOOR instead: `greatest(current, now() + days)`.
 *
 * `greatest` also means a booster who PAYS keeps the later of the two and never has paid
 * time truncated — the same reasoning `EXTEND_SQL`'s own comment gives for extending rather
 * than overwriting.
 *
 * ⚠️ AND IT ONLY LOGS WHEN THE FLOOR ACTUALLY MOVED BY MORE THAN A DAY. `supporter_grants`
 * is append-only and exists to answer "why does this account have a membership?"; an hourly
 * sweep writing 24 rows per booster per day would stop it answering that. Returns true only
 * when something really changed, so the sweep's own count is honest too.
 */
export async function ensureSupporterFloor(userId: string, days: number): Promise<boolean> {
  const rows = await q<{ until: string; moved: boolean }>(
    /* ⚠️ THE CTE SNAPSHOTS THE OLD VALUE, AND IT HAS TO. Postgres' `RETURNING` sees the
       row AFTER the update, so `supporter_until < now() + grace` compared there is always
       false — which silently made "did the floor move?" answer NO on every sweep including
       the first, and with it the audit row. (`RETURNING OLD.col` is PG 18; this runs on 17.) */
    `with prev as (select supporter_until as before from profiles where user_id = $1)
     update profiles p
        set supporter_until = greatest(coalesce(p.supporter_until, now()), now() + ($2 || ' days')::interval),
            updated_at = now()
       from prev
      where p.user_id = $1
      returning p.supporter_until as until,
                (prev.before is null or prev.before < now() + ($2 || ' days')::interval - interval '1 day') as moved`,
    [userId, String(days)],
  );
  const row = rows[0];
  if (!row) return false;
  if (!row.moved) return false;
  // months = 0 is a real, meaningful value here and 0019 already defines it as one.
  await logGrant(userId, 'boost', 0, row.until, 'discord server boost');
  return true;
}

async function logGrant(
  userId: string,
  source: GrantSource,
  months: number,
  until: string | null,
  note: string | null,
): Promise<void> {
  await q(
    `insert into supporter_grants (user_id, source, months, until, note)
     values ($1, $2, $3, $4, $5)`,
    [userId, source, months, until, note],
  );
}

/** audit trail for one account, newest first (admin console) */
export interface SupporterGrantRow {
  source: GrantSource;
  months: number;
  until: string | null;
  note: string | null;
  createdAt: string;
}

export async function listSupporterGrants(
  userId: string,
  limit = 20,
): Promise<SupporterGrantRow[]> {
  return q<SupporterGrantRow>(
    `select source, months, until, note, created_at as "createdAt"
       from supporter_grants where user_id = $1
      order by created_at desc limit $2`,
    [userId, limit],
  );
}

// ------------------------------------------------ earned cosmetic unlocks ---
//
// `profiles.cosmetics` (migration 0044) is the SECOND, SEPARATE ledger `docs/cosmetics-
// plan.md` §3.2/§3.7 calls for: a supporter's palette unlocks all at once off
// `supporter_until` (SUPPORTER_COL above) and never touches this column, so a lapsed
// membership can never delete something EARNED, and an earned unlock can never quietly
// become something sold. Written only by the server (an admin comp today; a rewards
// ledger per `docs/rewards-plan.md` later) — never by a client.

/** shape-check an id against the SAME closed set `coerceSpec`/`stripUnentitledCosmetics`
 *  clamp to, before it ever reaches SQL — a typo'd or stale axis name must not silently
 *  grant nothing while reporting success, and must never let a free-text value land in
 *  the column and later read back as "entitled". */
function isCosmeticId(id: string): boolean {
  const i = id.indexOf(':');
  if (i < 0) return false;
  const axis = id.slice(0, i) as keyof typeof COSMETIC_AXES;
  const key = id.slice(i + 1);
  return Object.prototype.hasOwnProperty.call(COSMETIC_AXES, axis) && COSMETIC_AXES[axis].includes(key);
}

/** this account's earned unlocks, or `[]`. The room join / ranked queue paths get this
 *  for free off `getProfile` above; this is for a caller that wants it alone. */
export async function getCosmeticsUnlocks(userId: string): Promise<string[]> {
  const rows = await q<{ cosmetics: string[] }>(
    `select cosmetics from profiles where user_id = $1`,
    [userId],
  );
  return rows[0]?.cosmetics ?? [];
}

/**
 * Grant one permanent unlock. Idempotent (the `?` containment check skips the write, and
 * still logs, when the account already has it — a re-run of a reward ledger must not pile
 * up duplicate array entries or duplicate audit rows for the SAME grant... though a repeat
 * call is rare enough that logging it plainly beats hiding it). Refuses silently (`false`)
 * on a malformed id or an unknown account, same shape as `revokeSupporter`.
 *
 * Logged to `admin_audit` (0041) exactly like a supporter grant — `source` is free text
 * (an admin's user id today, a ledger name like `'rewards'` once that ships), never a
 * client value.
 */
export async function grantCosmetic(
  userId: string,
  id: string,
  source = 'admin',
  note?: string,
): Promise<boolean> {
  if (!isCosmeticId(id)) return false;
  const rows = await q<{ user_id: string }>(
    `update profiles
        set cosmetics = case when cosmetics ? $2 then cosmetics else cosmetics || jsonb_build_array($2::text) end,
            updated_at = now()
      where user_id = $1
      returning user_id`,
    [userId, id],
  );
  if (rows.length === 0) return false;
  await writeAudit({ adminId: source, action: 'cosmetics.grant', targetUser: userId, detail: { id }, note: note ?? undefined });
  return true;
}

/** Revoke one earned unlock — a mistake, or a reward later retired. `false` if the
 *  account did not have it (nothing to revoke), matching `revokeSupporter`'s shape. */
export async function revokeCosmetic(
  userId: string,
  id: string,
  source = 'admin',
  note?: string,
): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `update profiles
        set cosmetics = cosmetics - $2::text,
            updated_at = now()
      where user_id = $1 and cosmetics ? $2
      returning user_id`,
    [userId, id],
  );
  if (rows.length === 0) return false;
  await writeAudit({ adminId: source, action: 'cosmetics.revoke', targetUser: userId, detail: { id }, note: note ?? undefined });
  return true;
}


// ----------------------------------------------------- season awards -------
/**
 * AN AWARD ROW — one placement an account holds, in the shape the profile's trophy case
 * reads (`AwardRow`, `src/awards.ts`).
 *
 * Two sources feed it:
 *   · `season_awards` (0045) — RETIRED by 0048. It minted per-SEASON ranked, solo AND duo
 *     record awards; nothing writes it now, and its rows stay in the trophy case.
 *   · CLAIMED competitive grants in `reward_grants` (0048) — the current criteria, minted
 *     by `runRewardJob` (owner, 2026-09-22): ranked TOP 3 per mode at the end of each ACT,
 *     solo record OVERALL TOP 3 and PER-DRIVETRAIN #1 at the end of each SEASON, never Act 0.
 */
export interface SeasonAward {
  game: Game;
  balanceVersion: number;
  act: number;
  /** the season's number within its act — “Act 2 Season 3” */
  seasonNo: number;
  kind: 'ranked' | 'ranked_act' | 'record_overall' | 'record_drivetrain';
  mode: '1v1' | '2v2' | 'solo' | 'duo';
  drivetrain: string | null;
  rank: number;
  userId: string;
  score: number | null;
}

export { awardKey };

/**
 * HOW DEEP EACH BOARD'S AWARD SLICE GOES — the owner's counts, in exactly one place
 * (2026-09-22: "ranked top 3 for 1v1 and 2v2 at the end of an ACT … at the end of each
 * SEASON, record top 3 for overall and top 1 for each drivetrain").
 */
export const AWARD_DEPTH = { ranked_act: 3, record_overall: 3, record_drivetrain: 1 } as const;

/** the drivetrains a per-drivetrain award is minted for. `DrivetrainType`, spelled out
 *  here because this module must not import from `src/types.ts` for a runtime value. */
export const AWARD_DRIVETRAINS = ['mecanum', 'tank', 'swerve', 'xdrive', 'butterfly'] as const;

/**
 * WHICH RECORD BOARDS A SEASON AWARD READS. SOLO ONLY, and that is a reading of the owner's
 * words rather than an accident: the 2026-09-22 criteria name "the records leaderboard" —
 * overall and each drivetrain — and REPLACE the 2026-09-21 set, which is the one that added
 * the duo board. Badges are meant to be rare, and a duo board would double the record payout
 * every season. Adding `'duo'` here is the whole change if that reading is wrong; a duo row
 * decorates BOTH members (`partnerId`), which `recordSeasonGrants` already handles.
 */
export const RECORD_AWARD_MODES: readonly ('solo' | 'duo')[] = ['solo'];

/** every award this account holds, newest season first — the profile read. */
export async function userAwards(userId: string): Promise<SeasonAward[]> {
  const rows = await q<{
    game: Game; balance_version: number; act: number; season_no: number; kind: SeasonAward['kind'];
    mode: SeasonAward['mode']; drivetrain: string | null; rank: number; score: number | null;
  }>(
    `select game, balance_version, act, season_no, kind, mode, drivetrain, rank, score
       from season_awards where user_id = $1
      order by balance_version desc, kind, mode, rank`,
    [userId],
  );
  return rows.map((r) => ({
    game: r.game as Game, balanceVersion: r.balance_version, act: r.act, seasonNo: r.season_no, kind: r.kind,
    mode: r.mode, drivetrain: r.drivetrain, rank: r.rank, userId, score: r.score,
  }));
}


// ------------------------------------------------------- the reward ledger ---
/**
 * THE REWARD LEDGER (migration 0048) — every badge and cosmetic an account is given. (Titles
 * were a third kind until they folded into badges, 0049.)
 *
 * Owner, 2026-09-22: "Whenever someone is given a title or a badge, do not just give it to
 * them without them getting anything. Titles should not ever silently get added UNLESS
 * specified." So a grant is PENDING until the player claims it through the dialog
 * (`src/ui/RewardDialog.tsx`), and a pending grant delivers NOTHING — no counted badge, no
 * unlocked cosmetic. Claiming applies it; "Equip now" claims and wears it.
 *
 * EVERY GRANT PATH GOES THROUGH `grantReward`. Today that is the competitive award job
 * (`runRewardJob`, run at boot and after every season roll) and the GitHub star sweep
 * (`sweepStargazers`). `grantCosmetic` still exists, but as the INVENTORY write a claim makes
 * — a new reward that called it directly would be exactly the silent grant this replaces.
 */

/**
 * WHICH SOURCES MAY SKIP THE DIALOG. Silent is a CODE-LEVEL decision, per source, and it is
 * OFF unless a row here says otherwise — a grant cannot ask to be silent, and nothing a
 * request carries reaches this table. The one silent source is `legacy`: the import of
 * rewards handed out before the ledger existed, which the player already has.
 */
export const REWARD_SOURCES: Readonly<Record<RewardSource, { silent: boolean }>> = {
  ranked_act: { silent: false },
  record_season: { silent: false },
  stargazer: { silent: false },
  legacy: { silent: true },
};
const rewardIsSilent = (s: RewardSource): boolean => REWARD_SOURCES[s]?.silent === true;

/** the grant key the GitHub star uses — one per account, forever (a re-star re-opens it). */
export const STARGAZER_KEY = 'stargazer';

/** read `profiles.equipped_badges` off a row, tolerating anything a hand-edit left there. */
function asEquipped(v: unknown): EquippedBadge[] {
  if (!Array.isArray(v)) return [];
  const out: EquippedBadge[] = [];
  for (const e of v) {
    const id = (e as { id?: unknown })?.id;
    const n = Number((e as { n?: unknown })?.n);
    if (isBadgeId(id) && Number.isFinite(n) && n >= 1 && !out.some((x) => x.id === id)) out.push({ id, n: Math.floor(n) });
  }
  return out.slice(0, MAX_EQUIPPED_BADGES);
}

/** is this a thing a grant may deliver? The same closed sets every other write checks. A
 *  `title` item (retired, 0049) is refused, and skipped wherever an old row is read back. */
function validItem(i: RewardItem): boolean {
  if (i.kind === 'badge') return isBadgeId(i.id);
  if (i.kind === 'cosmetic') return isCosmeticId(i.id);
  return false;
}

export interface RewardGrantInput {
  userId: string;
  /** names the reward AND its period — the unique key (`reward_grants_key_idx`) */
  key: string;
  source: RewardSource;
  reason: RewardReason;
  items: RewardItem[];
}

/** `created` a new pending grant · `reopened` a revoked one · `exists` nothing to do · `refused` no valid item */
export type GrantOutcome = 'created' | 'reopened' | 'exists' | 'refused';

/**
 * GRANT A REWARD — the one door. Pending unless its source is silent (`REWARD_SOURCES`).
 *
 * Idempotent on `(userId, key)`: a live grant (pending or claimed) is left exactly as it is,
 * so the award job, a retried roll and every Fly machine's boot can all call this for the
 * same winner and one row results. A REVOKED grant is re-opened as pending, which is what a
 * re-star means — the key stays spoken for, so it is never a second grant.
 */
export async function grantReward(input: RewardGrantInput, query: Tx = q): Promise<GrantOutcome> {
  const items = input.items.filter(validItem);
  if (items.length === 0) return 'refused';
  const silent = rewardIsSilent(input.source);
  const rows = await query<{ inserted: boolean }>(
    `insert into reward_grants (user_id, grant_key, source, reason, items, silent, claimed_at)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, case when $6 then now() else null end)
     on conflict (user_id, grant_key) do update
       set revoked_at = null,
           claimed_at = case when excluded.silent then now() else null end,
           silent = excluded.silent,
           reason = excluded.reason,
           items = excluded.items,
           created_at = now()
       where reward_grants.revoked_at is not null
     returning (xmax = 0) as inserted`,
    [input.userId, input.key, input.source, JSON.stringify(input.reason), JSON.stringify(items), silent],
  );
  if (rows.length === 0) return 'exists';
  if (silent) await applyItems(query, input.userId, items);
  return rows[0].inserted ? 'created' : 'reopened';
}

/**
 * DELIVER a claimed grant's items into the account's inventory. Cosmetics go into
 * `profiles.cosmetics` (so the entitlement strip and the entitlements payload see them exactly
 * as before); badges need no write — they are READ off the claimed grants (`badgeCounts`) —
 * beyond the badge projection.
 */
async function applyItems(query: Tx, userId: string, items: readonly RewardItem[]): Promise<string[]> {
  const ids = items.filter((i) => i.kind === 'cosmetic').map((i) => i.id);
  const added: string[] = [];
  for (const id of ids) {
    const r = await query<{ user_id: string }>(
      `update profiles set cosmetics = cosmetics || jsonb_build_array($2::text), updated_at = now()
        where user_id = $1 and not (cosmetics ? $2) returning user_id`,
      [userId, id],
    );
    if (r.length) added.push(id);
  }
  await refreshEquippedBadges(userId, undefined, query);
  return added;
}

/** HOW MANY TIMES this account has earned each badge — counted off CLAIMED, unrevoked grants,
 *  so a pending one does not count yet and a revoked one stops counting. */
export async function badgeCounts(userId: string, query: Tx = q): Promise<Record<string, number>> {
  const rows = await query<{ id: string; n: number }>(
    `select it->>'id' as id, count(*)::int as n
       from reward_grants g cross join lateral jsonb_array_elements(g.items) as it
      where g.user_id = $1 and g.claimed_at is not null and g.revoked_at is null
        and it->>'kind' = 'badge'
      group by 1`,
    [userId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) if (isBadgeId(r.id)) out[r.id] = Number(r.n);
  return out;
}

/**
 * REWRITE THE BADGE PROJECTION (`profiles.equipped_badges`) from the ledger.
 *
 * `want` is the list the player asked to wear (an equip); absent, the current list is kept.
 * Either way every entry is re-counted and anything no longer held drops out, which is the
 * ONE place that keeps the projection honest — every claim, revoke and equip ends here, so the
 * counter on a board row is never a number the ledger does not agree with.
 */
export async function refreshEquippedBadges(userId: string, want?: readonly string[], query: Tx = q): Promise<EquippedBadge[]> {
  const counts = await badgeCounts(userId, query);
  let ids = want ? [...want] : [];
  if (!want) {
    const cur = await query<{ equipped_badges: unknown }>(`select equipped_badges from profiles where user_id = $1`, [userId]);
    ids = asEquipped(cur[0]?.equipped_badges).map((b) => b.id);
  }
  const next: EquippedBadge[] = [...new Set(ids)]
    .filter((id) => isBadgeId(id) && (counts[id] ?? 0) > 0)
    .slice(0, MAX_EQUIPPED_BADGES)
    .map((id) => ({ id, n: counts[id] }));
  await query(
    `update profiles set equipped_badges = $2::jsonb, updated_at = now()
      where user_id = $1 and equipped_badges is distinct from $2::jsonb`,
    [userId, JSON.stringify(next)],
  );
  return next;
}

/**
 * WEAR these badges, in this order. Refused (null) for anything not held, a duplicate, an
 * unknown id or more than `MAX_EQUIPPED_BADGES` — the server decides what is earned, because a
 * badge beside a name is a claim to have won it.
 */
export async function setEquippedBadges(userId: string, ids: readonly string[]): Promise<EquippedBadge[] | null> {
  if (ids.length > MAX_EQUIPPED_BADGES || new Set(ids).size !== ids.length || !ids.every(isBadgeId)) return null;
  const counts = await badgeCounts(userId);
  if (!ids.every((id) => (counts[id] ?? 0) > 0)) return null;
  return refreshEquippedBadges(userId, ids);
}

interface GrantRow {
  id: string;
  source: RewardSource;
  reason: RewardReason;
  items: RewardItem[];
  created_at: string;
  claimed_at: string | null;
}
const grantOut = (r: GrantRow) => ({
  id: r.id,
  source: r.source,
  reason: r.reason,
  items: (Array.isArray(r.items) ? r.items : []).filter(validItem),
  createdAt: r.created_at,
  claimedAt: r.claimed_at,
});
export type RewardGrantRow = ReturnType<typeof grantOut>;

/** this account's PENDING grants — what the claim dialog queues. */
export async function pendingRewards(userId: string): Promise<RewardGrantRow[]> {
  const rows = await q<GrantRow>(
    `select id, source, reason, items, created_at, claimed_at from reward_grants
      where user_id = $1 and claimed_at is null and revoked_at is null
      order by created_at, id`,
    [userId],
  );
  return rows.map(grantOut);
}

/** everything the appearance page and the claim dialog need, in one read. */
export interface RewardState {
  pending: RewardGrantRow[];
  /** badge id → times earned (claimed only) */
  badges: Record<string, number>;
  equippedBadges: EquippedBadge[];
  /** the trophy case — every placement, with the act and season it is from */
  awards: SeasonAward[];
}

export async function rewardState(userId: string): Promise<RewardState> {
  const [pending, badges, prof, awards] = await Promise.all([
    pendingRewards(userId),
    badgeCounts(userId),
    q<{ equipped_badges: unknown }>(`select equipped_badges from profiles where user_id = $1`, [userId]),
    trophyCase(userId),
  ]);
  return {
    pending,
    badges,
    equippedBadges: asEquipped(prof[0]?.equipped_badges),
    awards,
  };
}

/**
 * CLAIM a grant — and with `equip`, wear it: each badge it carries is equipped
 * (`withBadgeEquipped` — the oldest makes room).
 *
 * One transaction: marking it claimed, delivering it and equipping it land together, so a
 * failure can never leave a grant claimed with nothing delivered. A second claim of the same
 * grant (a double click, two tabs) is not an error: it delivers nothing twice and still
 * honours `equip`. Returns null for a grant that is not this account's, or was revoked.
 */
export async function claimReward(userId: string, grantId: string, equip: boolean): Promise<RewardState | null> {
  const delivered = await tx(async (query) => {
    const hit = await query<{ items: RewardItem[] }>(
      `update reward_grants set claimed_at = now()
        where id = $1 and user_id = $2 and claimed_at is null and revoked_at is null
        returning items`,
      [grantId, userId],
    );
    let items: RewardItem[];
    let added: string[] = [];
    if (hit.length) {
      items = (Array.isArray(hit[0].items) ? hit[0].items : []).filter(validItem);
      added = await applyItems(query, userId, items);
    } else {
      const cur = await query<{ items: RewardItem[]; revoked_at: string | null }>(
        `select items, revoked_at from reward_grants where id = $1 and user_id = $2`,
        [grantId, userId],
      );
      if (!cur[0] || cur[0].revoked_at) return null;
      items = (Array.isArray(cur[0].items) ? cur[0].items : []).filter(validItem);
    }
    if (equip) {
      const badges = items.filter((i) => i.kind === 'badge').map((i) => i.id);
      if (badges.length) {
        const cur = await query<{ equipped_badges: unknown }>(`select equipped_badges from profiles where user_id = $1`, [userId]);
        let want = asEquipped(cur[0]?.equipped_badges).map((b) => b.id);
        for (const b of badges) want = withBadgeEquipped(want, b);
        await refreshEquippedBadges(userId, want, query);
      }
    }
    return added;
  });
  if (delivered === null) return null;
  // the inventory write is audited the way `grantCosmetic` audits it, so "why does this
  // account have this?" is still answered from `admin_audit` — outside the transaction,
  // because `writeAudit` never throws and must not be able to roll a claim back.
  for (const id of delivered) {
    await writeAudit({ adminId: 'rewards', action: 'cosmetics.grant', targetUser: userId, detail: { id, grant: grantId }, note: 'claimed' });
  }
  return rewardState(userId);
}

/**
 * REVOKE a grant by key — a withdrawn star, a disconnected GitHub account.
 *
 * Pending: it simply stops being offered. Claimed: what it delivered is taken back — its
 * cosmetics leave `profiles.cosmetics` unless another live grant also delivered them, and the
 * badge projection is re-counted (a badge no longer held drops off the name). The row stays (`revoked_at`), so the key is still spoken
 * for. Returns whether anything was live to revoke.
 */
export async function revokeReward(userId: string, key: string, note = 'revoked'): Promise<boolean> {
  const removed = await tx(async (query) => {
    const hit = await query<{ items: RewardItem[]; claimed_at: string | null }>(
      `update reward_grants set revoked_at = now()
        where user_id = $1 and grant_key = $2 and revoked_at is null
        returning items, claimed_at`,
      [userId, key],
    );
    if (!hit.length) return null;
    const items = (Array.isArray(hit[0].items) ? hit[0].items : []).filter(validItem);
    const out: string[] = [];
    if (hit[0].claimed_at) {
      const still = new Set(
        (
          await query<{ id: string }>(
            `select distinct it->>'id' as id
               from reward_grants g cross join lateral jsonb_array_elements(g.items) as it
              where g.user_id = $1 and g.claimed_at is not null and g.revoked_at is null`,
            [userId],
          )
        ).map((r) => r.id),
      );
      for (const i of items) {
        if (i.kind !== 'cosmetic' || still.has(i.id)) continue;
        const r = await query<{ user_id: string }>(
          `update profiles set cosmetics = cosmetics - $2::text, updated_at = now()
            where user_id = $1 and cosmetics ? $2 returning user_id`,
          [userId, i.id],
        );
        if (r.length) out.push(i.id);
      }
      await refreshEquippedBadges(userId, undefined, query);
    }
    return out;
  });
  if (removed === null) return false;
  for (const id of removed) {
    await writeAudit({ adminId: 'rewards', action: 'cosmetics.revoke', targetUser: userId, detail: { id, grant: key }, note });
  }
  return true;
}

/** the accounts holding a LIVE (pending or claimed, not revoked) grant under `key`. */
export async function liveGrantHolders(key: string): Promise<Set<string>> {
  const rows = await q<{ user_id: string }>(
    `select user_id from reward_grants where grant_key = $1 and revoked_at is null`,
    [key],
  );
  return new Set(rows.map((r) => r.user_id));
}

/**
 * THE COMPETITIVE AWARDS THIS ACCOUNT HAS CLAIMED, as trophy-case rows — one per placement
 * (a record grant can carry several). Pending ones are not here: the profile shows what the
 * player has taken, the same rule the badge picker follows.
 */
export async function competitiveAwards(userId: string): Promise<SeasonAward[]> {
  const rows = await q<{ reason: RewardReason }>(
    `select reason from reward_grants
      where user_id = $1 and claimed_at is not null and revoked_at is null
        and source in ('ranked_act', 'record_season')
      order by created_at`,
    [userId],
  );
  const out: SeasonAward[] = [];
  for (const { reason: r } of rows) {
    if (r?.kind === 'ranked_act') {
      out.push({
        game: r.game as Game, balanceVersion: r.balanceVersion ?? 0, act: r.act, seasonNo: 0, kind: 'ranked_act',
        mode: r.mode, drivetrain: null, rank: r.rank, userId, score: r.rating,
      });
    } else if (r?.kind === 'record_season') {
      for (const p of r.placements ?? []) {
        out.push({
          game: r.game as Game, balanceVersion: r.balanceVersion, act: r.act, seasonNo: r.seasonNo,
          kind: p.board === 'overall' ? 'record_overall' : 'record_drivetrain', mode: p.mode ?? 'solo',
          drivetrain: p.board === 'overall' ? null : p.board, rank: p.rank, userId, score: p.score,
        });
      }
    }
  }
  return out;
}

// -------------------------------------------------- the competitive award job ---
/**
 * PAY OUT EVERY CLOSED PERIOD THAT HAS NOT BEEN PAID — the backfill AND the rollover, one
 * function (owner, 2026-09-22: "give people the rewards NOW for past seasons. For new
 * seasons, it should be given automatically").
 *
 * Run at BOOT on every machine (`server/index.ts`) and after every season roll
 * (`startNewSeason`). Both are safe to repeat and safe to race: a period is claimed in
 * `reward_periods` inside the same transaction as its grants, so the first machine pays and
 * every other one finds the row and skips — and the grant key is a second, per-winner guard
 * under that. Steady state it reads `reward_periods` and each game's season list and stops.
 *
 * WHAT IS CLOSED, per game:
 *   · a SEASON is closed once `currentSeasonNumber` is past it — the same test every board
 *     read uses to decide "archived";
 *   · an ACT is closed once a season row exists in a LATER act. Deriving it from the current
 *     season's act instead would read Act 0 for a code-bumped version with no row yet, and
 *     call every act closed.
 * ⚠️ ACT 0 IS NEVER PAID (owner: "We do not count Act 0"), neither its ranked ladder nor the
 * record boards of the seasons inside it. Act 0 is the beta; a DECODE period only starts
 * counting once an admin opens Act 1.
 */
export async function runRewardJob(opts: { games?: readonly Game[]; fallback?: number } = {}): Promise<{ periods: number; grants: number }> {
  if (!dbEnabled) return { periods: 0, grants: 0 };
  const games = opts.games ?? GAME_IDS;
  const done = new Set(
    (await q<{ game: string; board: string; period: number }>(`select game, board, period from reward_periods`)).map(
      (r) => `${r.game}:${r.board}:${r.period}`,
    ),
  );
  let periods = 0;
  let grants = 0;
  for (const game of games) {
    const seasons = await listSeasons(game);
    const current = await currentSeasonNumber(opts.fallback ?? BALANCE_VERSION, game);
    // ACTS FROM REAL `seasons` ROWS ONLY — `listSeasons` also lists "ghost" versions that
    // hold data but no row, and reads their act as 0; those can neither close an act nor be
    // one.
    const rowActs = (await q<{ act: number; last: number }>(
      `select act, max(balance_version)::int as last from seasons where game = $1 group by act`,
      [g(game)],
    )).map((r) => ({ act: Number(r.act), last: Number(r.last) }));
    const maxAct = Math.max(0, ...rowActs.map((r) => r.act));

    for (const s of seasons) {
      if (s.act < 1 || s.season >= current) continue;
      if (done.has(`${game}:record_season:${s.season}`)) continue;
      const rows = await recordSeasonGrants(game, s.season, s.act, s.seasonNo);
      grants += await payPeriod(game, 'record_season', s.season, rows);
      periods++;
    }
    for (const { act, last } of rowActs) {
      if (act < 1 || act >= maxAct) continue;
      if (done.has(`${game}:ranked_act:${act}`)) continue;
      const rows = await rankedActGrants(game, act, last);
      grants += await payPeriod(game, 'ranked_act', act, rows);
      periods++;
    }
  }
  return { periods, grants };
}

/** claim one period and write its grants, atomically. Returns how many grants were new. */
async function payPeriod(game: Game, board: 'ranked_act' | 'record_season', period: number, rows: RewardGrantInput[]): Promise<number> {
  return tx(async (query) => {
    const claim = await query<{ period: number }>(
      `insert into reward_periods (game, board, period, winners) values ($1, $2, $3, $4)
       on conflict do nothing returning period`,
      [game, board, period, rows.length],
    );
    if (!claim.length) return 0; // another machine (or an earlier run) already paid it
    let n = 0;
    for (const r of rows) {
      const out = await grantReward(r, query);
      if (out === 'created' || out === 'reopened') n++;
    }
    return n;
  });
}

/**
 * THE RANKED PODIUM OF ONE CLOSED ACT: top 3 of each ladder, read through `eloLeaderboard` —
 * the board's own function, so the award agrees with the board (placed players only, the
 * board's order, `user_id` last so a tie is decided the same way every time).
 *
 * ⚠️ THE ACT'S FINAL STANDINGS ARE `elo_ratings` ROWS FOR THAT ACT, and nothing snapshotted
 * them at close before this job existed. They are what the database keeps: a rating row is
 * keyed by ACT (0013), stops moving the moment its act closes — every later match writes the
 * next act's row — and survives every season roll. Two things can still touch a closed act's
 * row and both are stated rather than hidden: a deleted account's rows are gone (there is
 * nobody left to award), and a behaviour charge (`chargeRatingForBehaviour`) lands on a
 * player's MOST RECENT board, which is a closed act's for somebody who has not played since.
 * From this job on, the award row itself records the rating the ladder closed on.
 */
async function rankedActGrants(game: Game, act: number, lastSeason: number): Promise<RewardGrantInput[]> {
  const out: RewardGrantInput[] = [];
  for (const mode of ['1v1', '2v2'] as const) {
    const rows = await eloLeaderboard({ mode, act, limit: AWARD_DEPTH.ranked_act, game });
    rows.forEach((r, i) => {
      const rank = i + 1;
      const badge = podiumBadge(rank);
      // the badge is the whole delivery; the placement itself lives on `reason`, which the
      // trophy case reads (`competitiveAwards`). A title rode here too until 0049.
      const items: RewardItem[] = badge ? [{ kind: 'badge', id: badge }] : [];
      out.push({
        userId: r.userId,
        key: `ranked:${game}:act${act}:${mode}`,
        source: 'ranked_act',
        reason: { kind: 'ranked_act', game, act, mode, rank, rating: Math.round(r.rating), balanceVersion: lastSeason },
        items,
      });
    });
  }
  return out;
}

/**
 * THE RECORD AWARDS OF ONE CLOSED SEASON: the overall board's top 3 and each drivetrain
 * board's #1, through `recordLeaderboard` with NO `physics` argument — its `boardPhysics`
 * default is the board the site shows, so the award cannot name a holder the board hides.
 * For a closed season that default is the era the season was played in, so BIOBUZZ Act 1's
 * 2D records pay their holders.
 *
 * ONE GRANT PER PLAYER PER SEASON, however many boards they placed on: every placement is its
 * own trophy-case row (off `reason.placements`), but the Record Holder badge counts SEASONS,
 * not boards. The overall #1 is nearly
 * always #1 of their own drivetrain as well, and a badge that ticked twice for one run would
 * make the rarer reward the commoner one.
 *
 * Final standings here need no snapshot: `records` rows are stamped with their season
 * (`balance_version`) and a closed season takes no new ones. What the board shows now is what
 * it showed at close, minus any run a moderator has deleted since.
 */
async function recordSeasonGrants(game: Game, balanceVersion: number, act: number, seasonNo: number): Promise<RewardGrantInput[]> {
  const byUser = new Map<string, RecordPlacement[]>();
  const add = (uid: string | null | undefined, p: RecordPlacement): void => {
    if (!uid) return;
    const list = byUser.get(uid) ?? [];
    list.push(p);
    byUser.set(uid, list);
  };
  for (const mode of RECORD_AWARD_MODES) {
    const tag = mode === 'duo' ? { mode: 'duo' as const } : {};
    const overall = await recordLeaderboard({ mode, balanceVersion, limit: AWARD_DEPTH.record_overall, game });
    overall.forEach((r, i) => {
      const p: RecordPlacement = { board: 'overall', rank: i + 1, score: Math.round(r.score), ...tag };
      add(r.userId, p);
      // a duo row is a PAIR's run, so both members are decorated
      if (mode === 'duo') add(r.partnerId, p);
    });
    for (const dt of AWARD_DRIVETRAINS) {
      const rows = await recordLeaderboard({ mode, drivetrain: dt, balanceVersion, limit: AWARD_DEPTH.record_drivetrain, game });
      rows.forEach((r, i) => {
        const p: RecordPlacement = { board: dt, rank: i + 1, score: Math.round(r.score), ...tag };
        add(r.userId, p);
        if (mode === 'duo') add(r.partnerId, p);
      });
    }
  }
  const out: RewardGrantInput[] = [];
  for (const [userId, placements] of byUser) {
    // the overall placement leads, then the drivetrains in registry order — the order the
    // dialog and the trophy case read them in
    placements.sort((a, b) => (a.board === 'overall' ? -1 : 0) - (b.board === 'overall' ? -1 : 0) || a.rank - b.rank);
    const items: RewardItem[] = [{ kind: 'badge', id: 'record-holder' }];
    out.push({
      userId,
      key: `record:${game}:bv${balanceVersion}`,
      source: 'record_season',
      reason: { kind: 'record_season', game, act, seasonNo, balanceVersion, placements },
      items,
    });
  }
  return out;
}


// ------------------------------------------------- linked social accounts --
/** the providers a DSIM account can link (0047). */
export type LinkProvider = 'github' | 'discord';

/**
 * LINKED SOCIAL ACCOUNTS (0047) and the STAR REWARD that reads them.
 * `docs/rewards-round2-plan.md` §2.1 / §3.1.
 */
export interface ProviderLink {
  provider: LinkProvider;
  providerUserId: string;
  userId: string;
  linkedAt: string;
  unlinkedAt: string | null;
}

/**
 * LINK an external account. Answers false when that external account is already bound to a
 * DIFFERENT DSIM account — including one that has since unlinked.
 *
 * ⚠️ THAT REFUSAL IS THE WHOLE ANTI-FARM, and it is why the row survives an unlink. Without
 * it, unlink → relink on a second account mints the reward again for free, which is the
 * cheapest farm available against any of these. Re-linking the SAME pair is allowed and
 * simply clears `unlinked_at`, because that is a person undoing their own mistake.
 */
export async function linkProvider(userId: string, provider: LinkProvider, providerUserId: string): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `insert into provider_links (provider, provider_user_id, user_id)
     values ($1, $2, $3)
     on conflict (provider, provider_user_id) do update
       set unlinked_at = null
       where provider_links.user_id = excluded.user_id
     returning user_id`,
    [provider, providerUserId, userId],
  );
  return rows.length > 0;
}

/** UNLINK: stamp `unlinked_at`, never delete — see `linkProvider`. */
export async function unlinkProvider(userId: string, provider: LinkProvider): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `update provider_links set unlinked_at = now()
      where user_id = $1 and provider = $2 and unlinked_at is null
      returning user_id`,
    [userId, provider],
  );
  return rows.length > 0;
}

/** what this account has linked right now (unlinked rows excluded). */
export async function providerLinks(userId: string): Promise<ProviderLink[]> {
  const rows = await q<{ provider: LinkProvider; provider_user_id: string; linked_at: string }>(
    `select provider, provider_user_id, linked_at from provider_links
      where user_id = $1 and unlinked_at is null order by provider`,
    [userId],
  );
  return rows.map((r) => ({ provider: r.provider, providerUserId: r.provider_user_id, userId, linkedAt: r.linked_at, unlinkedAt: null }));
}

/** every LIVE link for one provider — the sweep's left-hand side. */
export async function liveLinks(provider: LinkProvider): Promise<{ providerUserId: string; userId: string }[]> {
  const rows = await q<{ provider_user_id: string; user_id: string }>(
    `select provider_user_id, user_id from provider_links where provider = $1 and unlinked_at is null`,
    [provider],
  );
  return rows.map((r) => ({ providerUserId: r.provider_user_id, userId: r.user_id }));
}

/** the badge the GitHub star grants (a title, `title:stargazer`, until 0049). */
export const STARGAZER_BADGE = 'stargazer';
/**
 * …AND THE COSMETIC IT GRANTS WITH IT (owner, 2026-09-21: the star should carry something,
 * not just a mark on a name).
 *
 * ⚠️ **IT IS AN `earned`-TIER KEY, NOT ONE OF THE SUPPORTER FILLS**, and that was the whole
 * judgement: a star is one click, so gifting a premium chassis colour for it would price a
 * Ko-fi membership at one click. `decal:star` is absent from both tier sets in
 * `src/cosmetics.ts`, so `cosmeticTier` falls through to `'earned'` — the slot that file's
 * header has been holding open for the rewards ledger since the palette shipped. It costs the
 * supporter tier nothing and is worth more for being exclusive.
 *
 * ⚠️ BOTH MOVE TOGETHER, in the same direction, on the same set difference, because they ride
 * ONE grant: claiming it delivers both and revoking it takes both. Half a reward is a state no
 * sweep can repair later, and the ledger is what "why does this account have this?" is
 * answered from.
 */
export const STARGAZER_DECAL = 'decal:star';
/** everything the GitHub star is worth, in the order a person would read it. */
export const STARGAZER_ITEMS: readonly RewardItem[] = [
  { kind: 'badge', id: STARGAZER_BADGE },
  { kind: 'cosmetic', id: STARGAZER_DECAL },
];

/** every account holding one ledger id — ONE query, so a sweep does not ask per account. */
export async function cosmeticHolders(id: string): Promise<Set<string>> {
  const rows = await q<{ user_id: string }>(`select user_id from profiles where cosmetics ? $1`, [id]);
  return new Set(rows.map((r) => r.user_id));
}

export interface StarSweepResult {
  granted: string[];
  revoked: string[];
  /** false ⇒ nothing was changed, because the fetch could not be trusted. */
  applied: boolean;
}

/**
 * THE GITHUB STAR SWEEP — grant to everyone who stars, revoke from everyone who stops.
 *
 * `stargazers` is the COMPLETE set of stargazer ids for the repo, and `complete` says
 * whether the fetch that produced it actually finished. The caller does the HTTP; this does
 * the set algebra, so the interesting half is testable without a network or a token.
 *
 * ⚠️ **`complete: false` CHANGES NOTHING, AND THIS IS THE ENTIRE COST OF MAKING THE REWARD
 * REVOCABLE** (owner ruling, 2026-09-21: "unstarring should revoke the reward honestly").
 * Grant-only, a failed or truncated fetch meant "no new grants this cycle" and was harmless.
 * With revocation the SAME failure would strip the badge from every holder at once — a
 * non-2xx, a timeout, a page loop that ended early, or a `304 Not Modified` misread as an
 * empty list. So the sweep refuses to act on a set it does not trust, and the caller must
 * pass `complete: false` rather than an empty array when anything went wrong.
 *
 * Revocation costs no extra traffic: it is the same set difference read the other way. It
 * also costs no write for an account that did not hold the reward, because `revokeCosmetic`
 * is guarded by `and cosmetics ? $2`.
 *
 * ⚠️ AND IT TAKES THE WORN BADGE OFF THE NAME. `revokeReward` re-counts the badge projection,
 * so a `stargazer` badge in `profiles.equipped_badges` drops out in the same transaction —
 * the same rule `clearUsername` follows: no dangling reference for a render path to discover.
 */
export async function sweepStargazers(
  stargazers: readonly string[],
  complete: boolean,
): Promise<StarSweepResult> {
  if (!complete) return { granted: [], revoked: [], applied: false };
  const stars = new Set(stargazers);
  const links = await liveLinks('github');
  /**
   * ⚠️ WHO ALREADY HOLDS IT IS READ UP FRONT, IN ONE QUERY, AND IT IS NOT OPTIONAL. The set
   * difference decides who is granted, so a sweep where nothing changed writes nothing —
   * no grant, no audit row — rather than touching every linked account every hour.
   */
  /* ⚠️ HOLDING IT NOW MEANS EITHER OF TWO THINGS: a LIVE grant in the ledger (pending or
     claimed — a pending one must not be granted again every hour), or the decal already in
     `profiles.cosmetics` with no grant row (an account 0048's import somehow missed). The
     decal is the inventory's witness for the whole reward, because the badge has no inventory
     entry — it is read off the grant. Both sets are one query each. */
  const holders = await cosmeticHolders(STARGAZER_DECAL);
  const live = await liveGrantHolders(STARGAZER_KEY);
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const l of links) {
    const has = holders.has(l.userId) || live.has(l.userId);
    if (stars.has(l.providerUserId)) {
      if (has) continue;
      /* ⚠️ A PENDING GRANT, NOT A WRITE TO THE INVENTORY (0048). The player is shown the
         reward and claims it; until then the badge is not counted and the decal is locked.
         Both ride ONE grant, so they arrive — and later leave — as a unit. */
      const out = await grantReward({
        userId: l.userId,
        key: STARGAZER_KEY,
        source: 'stargazer',
        reason: { kind: 'stargazer' },
        items: [...STARGAZER_ITEMS],
      });
      if (out === 'created' || out === 'reopened') granted.push(l.userId);
    } else if (has) {
      if (await revokeStargazer(l.userId, 'github star withdrawn')) revoked.push(l.userId);
    }
  }
  return { granted, revoked, applied: true };
}

/**
 * TAKE THE STAR REWARD BACK — an unstar, or a disconnected GitHub account. Revokes the grant
 * (which takes back what a CLAIMED one delivered and re-counts the worn badges), then sweeps
 * the decal out of the inventory directly as well, for an account holding it with no grant
 * row at all.
 *
 * ⚠️ THE WORN BADGE COMES OFF, BUT THE EQUIPPED DECAL DOES NOT — they are different kinds of
 * state. `profiles.equipped_badges` is a projection OF the ledger, so it is re-counted. A saved
 * robot's `decal` is a plain key on a spec, and `stripUnentitledCosmetics` already downgrades
 * it at the server's live ingress on the next match.
 */
export async function revokeStargazer(userId: string, note: string): Promise<boolean> {
  let any = await revokeReward(userId, STARGAZER_KEY, note);
  if (await revokeCosmetic(userId, STARGAZER_DECAL, 'rewards', note)) any = true;
  return any;
}

// ------------------------------------------------------- Ko-fi payments -----
/** a Ko-fi webhook event, already parsed and priced by `server/kofi.ts` */
export interface KofiEventRow {
  messageId: string;
  kind: string;
  email: string | null;
  transactionId: string | null;
  amount: string | null;
  currency: string | null;
  isSubscription: boolean;
  tierName: string | null;
  /** months this payment is worth — 0 for a tip below the tier */
  months: number;
}

export interface KofiRecordResult {
  /** false when Ko-fi retried an event we already stored */
  fresh: boolean;
  /** user id this was auto-granted to by matching `profiles.kofi_email`, if any */
  autoGrantedTo: string | null;
  /** supporter_until after an auto-grant */
  until: string | null;
}

/**
 * Record a Ko-fi webhook event and, when the payer is already known, grant it.
 *
 * IDEMPOTENCY: `message_id` is the primary key and Ko-fi retries delivery, so the
 * insert itself is the guard — there is no read-then-write race between the five
 * regional machines, and a retry cannot grant a second month. Everything below
 * the insert is skipped unless the insert actually took.
 *
 * AUTO-RENEWAL is the whole point of the email link. A membership's second month
 * arrives as a brand-new event with a new transaction id; without matching it to
 * the account that claimed the first one, the supporter silently lapses and has
 * to paste a new id every 30 days. `profiles.kofi_email` (set by the first manual
 * claim) closes that loop. A payer we have never seen still parks the payment for
 * a manual claim, which is how the FIRST one always works.
 */
export async function recordKofiPayment(p: KofiEventRow): Promise<KofiRecordResult> {
  return tx(async (query) => {
    const inserted = await query<{ message_id: string }>(
      `insert into kofi_payments
         (message_id, kind, email, transaction_id, amount, currency,
          is_subscription, tier_name, months)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (message_id) do nothing
       returning message_id`,
      [
        p.messageId,
        p.kind,
        p.email ? p.email.trim().toLowerCase() : null,
        p.transactionId,
        p.amount,
        p.currency,
        p.isSubscription,
        p.tierName,
        Math.max(0, Math.floor(p.months)),
      ],
    );
    if (inserted.length === 0) return { fresh: false, autoGrantedTo: null, until: null };
    if (!p.email || p.months <= 0) return { fresh: true, autoGrantedTo: null, until: null };

    const owner = await query<{ user_id: string }>(
      `select user_id from profiles where kofi_email = $1`,
      [p.email.trim().toLowerCase()],
    );
    if (!owner[0]) return { fresh: true, autoGrantedTo: null, until: null };
    const userId = owner[0].user_id;

    await query(
      `update kofi_payments
          set claimed_by = $1, claimed_at = now(), auto_claimed = true
        where message_id = $2`,
      [userId, p.messageId],
    );
    const granted = await query<{ until: string }>(EXTEND_SQL, [userId, String(p.months)]);
    const until = granted[0]?.until ?? null;
    await query(
      `insert into supporter_grants (user_id, source, months, until, note)
       values ($1, 'kofi', $2, $3, $4)`,
      [userId, p.months, until, `auto: ${p.messageId}`],
    );
    return { fresh: true, autoGrantedTo: userId, until };
  });
}

export type ClaimOutcome =
  | 'ok'
  | 'not-found'
  | 'already-claimed'
  | 'below-tier'
  | 'email-taken'
  | 'refunded';

export interface ClaimResult {
  outcome: ClaimOutcome;
  until?: string | null;
  /** months granted (outcome 'ok') */
  months?: number;
  /** the payment, so the caller can explain a 'below-tier' rejection precisely */
  payment?: { kind: string; amount: string | null; currency: string | null; isSubscription: boolean; tierName: string | null };
}

/**
 * Attach an unclaimed payment to an account, grant the membership, and LINK the
 * payer's email so every future payment from it renews automatically.
 *
 * One transaction throughout. The claiming UPDATE matches only
 * `claimed_by is null`, so two accounts racing the same transaction id cannot
 * both win — the loser updates zero rows and gets 'already-claimed'.
 *
 * The email link is the part that needs care: it is UNIQUE across profiles, so a
 * second account claiming a payment from an address already linked elsewhere is
 * rejected ('email-taken') rather than allowed to quietly steal the renewal
 * stream of the first. That is also the only thing stopping one $3 subscription
 * from removing ads on an unlimited number of accounts.
 */
export async function claimKofiPayment(
  userId: string,
  transactionId: string,
): Promise<ClaimResult> {
  return tx(async (query) => {
    const found = await query<{
      message_id: string;
      claimed_by: string | null;
      email: string | null;
      months: number;
      kind: string;
      amount: string | null;
      currency: string | null;
      is_subscription: boolean;
      tier_name: string | null;
      refunded_at: string | null;
    }>(
      `select message_id, claimed_by, email, months, kind, amount, currency,
              is_subscription, tier_name, refunded_at
         from kofi_payments where transaction_id = $1`,
      [transactionId],
    );
    const row = found[0];
    if (!row) return { outcome: 'not-found' as const };

    const payment = {
      kind: row.kind,
      amount: row.amount,
      currency: row.currency,
      isSubscription: row.is_subscription,
      tierName: row.tier_name,
    };
    if (row.refunded_at) return { outcome: 'refunded' as const, payment };
    if (row.claimed_by) return { outcome: 'already-claimed' as const, payment };
    // Recorded, but it bought nothing. Deliberately NOT claimed — leaving it open
    // means an admin can still comp it, and the buyer can top up to the tier and
    // claim the larger payment instead.
    if (row.months <= 0) return { outcome: 'below-tier' as const, payment };

    // Link the payer address for auto-renewal. `where kofi_email is null` keeps
    // this from clobbering an address the account already linked (someone whose
    // second subscription came from a different PayPal keeps their first link and
    // simply claims by hand — annoying, but never silently redirecting renewals).
    const email = row.email ? row.email.trim().toLowerCase() : null;
    if (email) {
      const taken = await query<{ user_id: string }>(
        `select user_id from profiles where kofi_email = $1`,
        [email],
      );
      if (taken[0] && taken[0].user_id !== userId) {
        return { outcome: 'email-taken' as const, payment };
      }
      if (!taken[0]) {
        await query(
          `update profiles set kofi_email = $2, updated_at = now()
            where user_id = $1 and kofi_email is null`,
          [userId, email],
        );
      }
    }

    // `returning` is how we detect whether the row was still unclaimed — the Tx
    // helper hands back rows, not a rowCount, so a bare UPDATE would look the
    // same whether it matched or not.
    const claimed = await query<{ message_id: string }>(
      `update kofi_payments set claimed_by = $1, claimed_at = now()
        where transaction_id = $2 and claimed_by is null
        returning message_id`,
      [userId, transactionId],
    );
    if (claimed.length === 0) return { outcome: 'already-claimed' as const, payment };

    const granted = await query<{ until: string }>(EXTEND_SQL, [userId, String(row.months)]);
    const until = granted[0]?.until ?? null;
    await query(
      `insert into supporter_grants (user_id, source, months, until, note)
       values ($1, 'kofi', $2, $3, $4)`,
      [userId, row.months, until, `claim: ${row.message_id}`],
    );
    return { outcome: 'ok' as const, until, months: row.months, payment };
  });
}

/**
 * Mark a payment refunded/charged back. Does NOT revoke on its own — the
 * entitlement is a running instant that may also cover other payments, so the
 * admin decides whether to revoke as a separate act.
 */
/**
 * The payments one account has CLAIMED — the console's way into `refundKofiPayment`.
 *
 * `/api/admin/supporter/refund?txn=` has existed since 0018 and nothing in the console could
 * reach it, because the panel showed `supporter_grants` (what was granted) and a refund is
 * keyed by the PAYMENT (what was paid). They are not the same row and one does not carry the
 * other's id: a grant is months, a payment is a transaction. This is the missing half.
 *
 * `claimed_by` is already indexed as a foreign key (0037's sweep), so this is a cheap read on
 * a panel that runs ten of them at once. The buyer's EMAIL is deliberately not projected — it
 * is stored to match a claim and never displayed (0018 says so), and the console is not an
 * exception to that.
 */
export interface KofiPaymentRow {
  transactionId: string | null;
  kind: string;
  amount: string | null;
  currency: string | null;
  isSubscription: boolean;
  claimedAt: string | null;
  refundedAt: string | null;
}

export async function listKofiPayments(userId: string, limit = 20): Promise<KofiPaymentRow[]> {
  const rows = await q<{
    transaction_id: string | null; kind: string; amount: string | null; currency: string | null;
    is_subscription: boolean; claimed_at: string | null; refunded_at: string | null;
  }>(
    `select transaction_id, kind, amount::text as amount, currency, is_subscription,
            claimed_at, refunded_at
       from kofi_payments where claimed_by = $1
      order by created_at desc limit $2`,
    [userId, Math.min(100, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((r) => ({
    transactionId: r.transaction_id,
    kind: r.kind,
    amount: r.amount,
    currency: r.currency,
    isSubscription: r.is_subscription,
    claimedAt: r.claimed_at,
    refundedAt: r.refunded_at,
  }));
}

export async function refundKofiPayment(transactionId: string): Promise<boolean> {
  const rows = await q<{ message_id: string }>(
    `update kofi_payments set refunded_at = now()
      where transaction_id = $1 and refunded_at is null
      returning message_id`,
    [transactionId],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------- replays ------
/** Persist a replay. `season` (= currentSeasonNumber) is the SEASON stamp used for
 * purge-by-season; `replay.balanceVersion` is the real sim-code version that
 * recorded it (config.BALANCE_VERSION) — stored separately in `sim_version` so the
 * playback gate compares CODE-vs-CODE, not code-vs-season. `game` keys the board
 * this replay belongs to (DECODE vs Chain Reaction). */
export async function saveReplay(replay: Replay, season: number, game?: Game): Promise<string> {
  /* THE ROBOT NAME IS DRAWN ON THE FIELD. `src/render/renderer.ts` labels every robot from
   * `spec.name`/`spec.teamNumber`, so an unmoderated name is public in the replay viewer AND
   * burned into every exported video — the one copy of a match that outlives the sim version
   * that recorded it. It is scrubbed HERE and not in `server/persist.ts` because this is the
   * ONE funnel all three replay writers share (the match path, `savePracticeRun`, and
   * `saveLanRun`). The LAN path is the one that was actually open: `server/api.ts` moderates
   * the roster it DISPLAYS and then hands `sanitizeReplay(body.replay)` straight through, and
   * `sanitizeReplay` only clamps geometry — so a THIRD PARTY's name inside a client-uploaded
   * container was stored unscrubbed. Free when moderation is off: `scrubSpecNames` returns
   * the same object identity for a clean spec. */
  const setups = await Promise.all(
    replay.setups.map(async (s) => ({ ...s, spec: await scrubSpecNames(s.spec) })),
  );
  const rows = await q<{ id: string }>(
    `insert into replays (format, balance_version, sim_version, behaviour_version, seed, ticks, setups, tracks, game, physics)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      replay.format,
      season, // balance_version = SEASON (purge key + index, see 0004)
      replay.balanceVersion, // sim_version = the sim-code version that recorded it
      // ...and behaviour_version = SIM_VERSION, the one the playback gate actually compares.
      // Without it `getReplay` could not set `Replay.sim`, an absent `sim` reads as 0, and
      // EVERY stored replay was refused as stale on every build (see migration 0031).
      replay.sim ?? null,
      replay.seed,
      replay.ticks,
      JSON.stringify(setups),
      JSON.stringify(replay.tracks),
      g(game),
      // ...and WHICH PHYSICS recorded it (0039). The column is `not null default '2d'`, so an
      // absent tag is written as the string that default already means rather than as null —
      // playback DISPATCHES on this, and one nullable spelling of '2d' is one too many.
      replay.physics ?? '2d',
    ],
  );
  return rows[0].id;
}

export async function getReplay(id: string): Promise<Replay | null> {
  const rows = await q<{
    format: number;
    balance_version: number;
    sim_version: number | null;
    behaviour_version: number | null;
    game: Game;
    seed: string;
    ticks: number;
    setups: Replay['setups'];
    tracks: Replay['tracks'];
    physics: string | null;
  }>(
    `select format, balance_version, sim_version, behaviour_version, game, seed, ticks, setups, tracks, physics
       from replays where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    format: r.format,
    // the gate re-sims: it needs the CODE version. Fall back to balance_version for
    // any legacy row the sim_version backfill somehow missed.
    balanceVersion: r.sim_version ?? r.balance_version,
    // LEFT UNDEFINED when the column is null, which is what a row recorded before 0031 is:
    // the behaviour it ran is genuinely unknown. It is still REFUSED — `replayRefusal` reads
    // an absent stamp as version 0 like it always has — but it comes back as `unstamped`
    // rather than `behaviour`, so the viewer says "recorded before we tracked this" instead of
    // naming a version the recorder never claimed. Undefined, not 0, is what carries that.
    sim: r.behaviour_version ?? undefined,
    game: r.game ?? 'decode', // picks the sim module to re-simulate (CR vs DECODE)
    // WHICH SOLVE to re-simulate it on. Left UNDEFINED for anything that is not the one known
    // non-default value — a pre-0039 row, a null, or a string this build does not know — every
    // one of which reads '2d' downstream, which is what such a row actually ran.
    physics: r.physics === '3d' ? '3d' : undefined,
    mode: 'match',
    seed: Number(r.seed),
    ticks: r.ticks,
    setups: r.setups,
    tracks: r.tracks,
  };
}

// ---------------------------------------------------- replay privacy --------
/**
 * WHO MAY WATCH A STORED REPLAY (migration 0038).
 *
 * A replay is an input log re-simulated at full fidelity, so it does not show a score — it
 * shows the whole game plan. `/api/replay/<id>` used to serve any of them to anyone, and the
 * public profile hands out the ids, so every stranger's match history was a scouting feed.
 *
 * The rule, per owner:
 *   versus   — EVERYONE WHO PLAYED IN IT, always, from either side. It is as much their match
 *              as anybody's, and they already watched the whole thing live. Outside that
 *              roster, only when EVERY participant has opted in: the replay shows both
 *              alliances, so a unilateral opt-in would publish the opponent's strategy as
 *              surely as the opter's own, and an opt-out your opponent can defeat is not one.
 *   record   — public. A record run is a leaderboard submission and its replay is the PROOF;
 *              the board is self-policing precisely because anyone can re-simulate the log
 *              behind a number, and a score-attack run has no opponent in it to expose.
 *   practice — its owner only, matching `/api/practice`, which is self-scoped on both verbs.
 *              Unverified offline runs were never meant to be readable by anyone else; the
 *              unguessable uuid was the only thing that made that true.
 *   lan      — THE HOST ONLY. A self-hosted match is somebody's own event on somebody's own
 *              machine, and `lan_runs` already exposes exactly one read path (one host's own
 *              matches, 0033). Its drivers are NAMES rather than accounts, so there is nobody
 *              else to grant it to and `replays_public` cannot speak for them — which is the
 *              argument for keeping it shut rather than for leaving it open. It still lands in
 *              the database, where staff can reach it.
 *
 * STAFF may watch anything. Score corrections and report adjudication reach a replay through
 * this same route (`AdminReports` → `watchReplay` → `/replay/<id>`), and moderation that
 * cannot see the match is not moderation. `profiles.role` is the projection of
 * `ADMIN_USER_IDS` that exists so exactly this kind of question can be answered in SQL.
 *
 * ⚠️ **UNANIMITY IS OVER THE WHOLE ROSTER, NOT OVER THE ROWS THAT HAPPEN TO SURVIVE.**
 * `match_participants` holds a row only for an AUTHED player (`persistMatch` drops the rest)
 * and cascades away with a deleted profile, so "every row says yes" is NOT the same question
 * as "everyone who played said yes". A 1v1 against a signed-out opponent stores ONE row, and
 * publishing on that row alone would publish a match against somebody who was never asked and
 * has no account to ask with. So the count is checked against what `matches.mode` says the
 * roster was: 2 for a 1v1, 4 for a 2v2. Short of that, the match never goes public — a
 * departed or anonymous player is a permanent no, which is the safe direction for a consent
 * check to fail in.
 *
 * DEFAULT DENY. A replay nothing points at is refused: every table with a `replay_id` is
 * named above (`grep replay_id server/db/migrations/`), so an unrecognised owner means an
 * orphan — and a privacy gate whose unknown case is "allow" is one a later migration opens
 * by accident.
 */
export type ReplayOwnerKind = 'versus' | 'record' | 'practice' | 'lan';
export interface ReplayAccessResult {
  access: 'ok' | 'private' | 'missing';
  /** what KIND of thing refused, so the refusal can say the right sentence. A private versus
   * match, somebody else's practice run and a self-hosted event are three different answers
   * to "why can I not watch this", and one generic line is wrong about two of them. Null for
   * an orphan, which has nothing true to say. */
  kind: ReplayOwnerKind | null;
}

/** how many accounts SHOULD be on a versus roster — see the roster note above */
const ROSTER_SIZE: Record<string, number> = { '1v1': 2, '2v2': 4 };

export async function replayAccess(
  replayId: string,
  viewerId: string | null,
): Promise<ReplayAccessResult> {
  // the owner fan-out and "does this id exist at all" are separate questions, and both are
  // primary-key lookups. Asking them together lets a MISSING replay come back as 404 rather
  // than as a privacy refusal — a purged season's dead link is not somebody keeping a secret.
  const [present, owners] = await Promise.all([
    q<{ ok: number }>(`select 1 as ok from replays where id = $1`, [replayId]),
    q<{ kind: ReplayOwnerKind; user_id: string | null; mode: string | null; is_public: boolean }>(
      `with owners as (
         select mp.user_id as user_id, 'versus' as kind, m.mode as mode
           from matches m join match_participants mp on mp.match_id = m.id
          where m.replay_id = $1
         union all
         select r.user_id, 'record', null from records r where r.replay_id = $1
         union all
         select r.partner_id, 'record', null from records r
          where r.replay_id = $1 and r.partner_id is not null
         union all
         select p.user_id, 'practice', null from practice_runs p where p.replay_id = $1
         union all
         select l.host_user_id, 'lan', null from lan_runs l where l.replay_id = $1
       )
       select o.kind, o.user_id, o.mode, coalesce(p.replays_public, false) as is_public
         from owners o left join profiles p on p.user_id = o.user_id`,
      [replayId],
    ),
  ]);
  if (!present.length) return { access: 'missing', kind: null };
  // an orphan — see DEFAULT DENY above
  if (!owners.length) return { access: 'private', kind: null };

  const kind = owners[0].kind;
  // YOU PLAYED IN IT. True for either alliance of a versus match, for the owner of a practice
  // run, and for the host of a LAN upload — one predicate, because in each case the row IS
  // the claim that this person was there.
  if (viewerId && owners.some((o) => o.user_id === viewerId)) return { access: 'ok', kind };

  if (kind === 'record') return { access: 'ok', kind };
  if (
    kind === 'versus' &&
    versusReleased(
      owners[0].mode,
      owners.length,
      owners.every((o) => o.is_public),
    )
  ) {
    return { access: 'ok', kind };
  }

  // Everything below here is a refusal for an ordinary viewer, so the staff lookup is the
  // only branch that costs a second round trip — and it runs for a signed-in caller who has
  // just been told no, not for every replay anybody watches.
  if (viewerId && (await isStaffUser(viewerId))) return { access: 'ok', kind };
  return { access: 'private', kind };
}

/** has a versus match been released to the public? Every stored participant opted in AND the
 * stored participants are the whole roster — see the roster note on `replayAccess`.
 *
 * ⚠️ TWO CALLERS, AND THAT IS WHY IT TAKES SCALARS. `replayAccess` enforces it on the fetch;
 * `userMatchHistory` reads it to decide whether to hand the row a `replayId` at all. They ran
 * on two copies of the rule for one round and the copies disagreed about the roster count, so
 * a 1v1 against a signed-out opponent drew a Watch button the fetch then answered 403 — a
 * button that fails is worse than no button. One function, both callers. */
function versusReleased(mode: string | null, stored: number, unanimous: boolean): boolean {
  return unanimous && stored === (ROSTER_SIZE[mode ?? ''] ?? Number.POSITIVE_INFINITY);
}

/** the sentence a refusal says. Lives beside the rule rather than in the route, so a new owner
 * kind cannot be added without an answer to "why can I not watch this". */
export function replayRefusalMessage(kind: ReplayOwnerKind | null): string {
  switch (kind) {
    case 'versus':
      return 'This replay is private. Everyone who played in the match has to allow it.';
    case 'practice':
      return 'That is somebody else’s solo practice run.';
    case 'lan':
      return 'This match was played on a self-hosted server. Only the host who uploaded it can watch it back.';
    default:
      return 'This replay is private.';
  }
}

/** `profiles.role` is a projection of `ADMIN_USER_IDS` (0020) — the env is still the source
 * of truth, this is just the copy a query can join against. */
export async function isStaffUser(userId: string): Promise<boolean> {
  const rows = await q<{ role: string | null }>(
    `select role from profiles where user_id = $1 and role in ('owner', 'admin')`,
    [userId],
  );
  return rows.length > 0;
}

// ------------------------------------------------- terms acceptance ---------
/**
 * WHICH REVISION OF THE TERMS THIS ACCOUNT ACCEPTED (migration 0040).
 *
 * Two nullable columns on `profiles`, read and written by primary key only — see the
 * migration for why there is no index and why null means "never asked" rather than
 * being back-filled with the current revision.
 */
export interface TermsAcceptance {
  /** the `LEGAL_VERSION` key that was accepted, or null if never */
  version: string | null;
  /**
   * The instant it was recorded, or null if never.
   *
   * TYPED AS THE WIRE SHAPE, like `SupporterState.supporterUntil` beside it: the driver
   * hands a `timestamptz` back as a Date, and `JSON.stringify` on the route turns that
   * into an ISO string, which is the only form any caller of this ever sees. Anything
   * comparing it in-process has to compare the INSTANT, not the object.
   */
  acceptedAt: string | null;
}

const NEVER_ACCEPTED: TermsAcceptance = { version: null, acceptedAt: null };

/** what this account has accepted (never-accepted for an unknown account, which is
 *  the same answer and the same consequence: the client's gate asks). */
export async function getTermsAcceptance(userId: string): Promise<TermsAcceptance> {
  const rows = await q<{ terms_version: string | null; terms_accepted_at: string | null }>(
    `select terms_version, terms_accepted_at from profiles where user_id = $1`,
    [userId],
  );
  if (!rows[0]) return NEVER_ACCEPTED;
  return { version: rows[0].terms_version, acceptedAt: rows[0].terms_accepted_at };
}

/**
 * Record an acceptance of `version`.
 *
 * ⚠️ THE TIMESTAMP IS `now()` IN POSTGRES, never a client clock and never a Node one:
 * the five regional machines do not share a clock, and a consent record whose date came
 * off the accepting browser is evidence of nothing. Same rule the supporter expiry reads
 * by.
 *
 * ⚠️ THE VERSION IS THE SERVER’S OWN CONSTANT, not a string off the wire — the route
 * passes `LEGAL_VERSION`, so a client cannot claim to have accepted a revision that does
 * not exist (or the NEXT one, pre-emptively, to skip the gate forever).
 *
 * OVERWRITES rather than appending. A history of every revision somebody accepted would
 * be a second table and its own retention question; what the gate needs is the latest,
 * and what a dispute needs is that the latest was accepted and when.
 */
export async function acceptTerms(userId: string, version: string): Promise<TermsAcceptance> {
  const rows = await q<{ terms_version: string | null; terms_accepted_at: string | null }>(
    `update profiles
        set terms_version = $2, terms_accepted_at = now(), updated_at = now()
      where user_id = $1
      returning terms_version, terms_accepted_at`,
    [userId, version],
  );
  if (!rows[0]) return NEVER_ACCEPTED; // no such profile ⇒ nothing was recorded
  return { version: rows[0].terms_version, acceptedAt: rows[0].terms_accepted_at };
}

/** does this account let anyone watch its versus replays? (false for an unknown account) */
export async function getReplaysPublic(userId: string): Promise<boolean> {
  const rows = await q<{ replays_public: boolean }>(
    `select replays_public from profiles where user_id = $1`,
    [userId],
  );
  return !!rows[0]?.replays_public;
}

/** set it. The profile row is ensured by the caller, as with every other settings write. */
export async function setReplaysPublic(userId: string, value: boolean): Promise<void> {
  await q(`update profiles set replays_public = $2, updated_at = now() where user_id = $1`, [
    userId,
    value,
  ]);
}

// ------------------------------------------------- solo practice runs -------
/**
 * How many practice runs an account keeps. Oldest are pruned on insert.
 *
 * Solo practice is the primary OFFLINE mode, so these arrive at whatever rate somebody
 * practises — unbounded, unlike matches, which cost a queue and an opponent. Ten is about a
 * session's worth to look back through and bounds the cost per account at a few hundred KB.
 * It is one number on purpose: raising it is a storage decision, not a code change.
 */
export const PRACTICE_KEEP = 10;

export interface PracticeRunRow {
  id: string;
  game: Game;
  score: number;
  ticks: number;
  replayId: string | null;
  createdAt: string;
  /** which solve ran it ('2d' | '3d'). Stored rather than inferred from the date: only a
   *  3D-physics run is comparable with a ranked result, and the date stops meaning that the
   *  first time somebody replays an old container. */
  physics?: string;
  /** which renderer it was watched in, or null for a run recorded before the column */
  view?: string | null;
}

/**
 * Store one offline practice run for a player and prune their oldest past `PRACTICE_KEEP`.
 *
 * THE SCORE HERE IS CLIENT-REPORTED and that is not a bug to fix later — solo practice runs on
 * the local sim with no server in the loop, so there is nothing authoritative to check it
 * against. It is safe because of where it can go: `practice_runs` is not reachable from
 * `record_leaderboard`, which is a view over `records`, so no board, PB, rank or ELO figure
 * can be moved by anything written here. It is shown only on the owner's own Career list.
 *
 * The replay row is the SAME shape every other replay uses, so the viewer, the version gate
 * and the season purge all work on it unchanged (the purge deletes from `replays` by season,
 * and `replay_id` is `on delete set null`, so a purged run degrades exactly like a record).
 */
export async function savePracticeRun(
  userId: string,
  replay: Replay,
  score: number,
  season: number,
  game?: Game,
  /** which RENDERER the player watched it in ('2d' | '3d'), or undefined if unstated. Purely
   *  descriptive; `physics` — what was SIMULATED — is read off the replay container itself,
   *  so the two can never disagree about the same run. */
  view?: string,
): Promise<PracticeRunRow> {
  const replayId = await saveReplay(replay, season, game);
  const physics = replay.physics ?? '2d';
  const viewCol = view === '2d' || view === '3d' ? view : null;
  const rows = await q<{ id: string; created_at: string }>(
    `insert into practice_runs (user_id, game, balance_version, score, ticks, replay_id, physics, view)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at`,
    [userId, g(game), season, Math.max(0, Math.round(score)), replay.ticks, replayId, physics, viewCol],
  );

  // PRUNE, and delete the pruned runs' replays with them. A replay has no back-reference to
  // the run that owns it, so dropping the row alone would leak the log — the same trap the
  // account-deletion path documents.
  const stale = await q<{ replay_id: string | null }>(
    `delete from practice_runs
      where id in (
        select id from practice_runs
         where user_id = $1 and game = $2
         order by created_at desc
         offset $3
      )
      returning replay_id`,
    [userId, g(game), PRACTICE_KEEP],
  );
  const ids = stale.map((r) => r.replay_id).filter((x): x is string => !!x);
  if (ids.length) await q(`delete from replays where id = any($1::uuid[])`, [ids]);

  return {
    id: rows[0].id,
    game: g(game),
    score,
    ticks: replay.ticks,
    replayId,
    createdAt: rows[0].created_at,
    physics,
    view: viewCol,
  };
}

/** a player's own practice runs, newest first. Owner-only — see the API route. */
export async function listPracticeRuns(
  userId: string,
  game?: Game,
  limit = PRACTICE_KEEP,
): Promise<PracticeRunRow[]> {
  const rows = await q<{
    id: string;
    game: Game;
    score: number;
    ticks: number;
    replay_id: string | null;
    created_at: string;
    physics: string | null;
    view: string | null;
  }>(
    `select id, game, score, ticks, replay_id, created_at, physics, view
       from practice_runs
      where user_id = $1 and game = $2
      order by created_at desc
      limit $3`,
    [userId, g(game), Math.min(PRACTICE_KEEP, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    game: r.game,
    score: r.score,
    ticks: r.ticks,
    replayId: r.replay_id,
    createdAt: r.created_at,
    physics: r.physics ?? '2d',
    view: r.view,
  }));
}

// ------------------------------------------------- self-hosted LAN runs ----
/**
 * How many self-hosted matches an account keeps as the HOST. Oldest pruned on insert.
 *
 * Higher than `PRACTICE_KEEP` on purpose: a team scrimmaging at a venue plays matches back to
 * back all afternoon, and unlike practice runs each one has several people in it who may want
 * to look at it. Still one number, still a storage decision rather than a code change.
 */
export const LAN_KEEP = 40;

/** who the hosting server says was in the match. NAMES ONLY — see the migration. */
export interface LanParticipant {
  name: string;
  teamName?: string;
  teamNumber?: number;
  alliance: 'red' | 'blue';
  drivetrain?: string;
}

export interface LanRunRow {
  id: string;
  matchId: string;
  /** the account that filed this match. Read by the ownership check in `saveLanRun`. */
  hostUserId: string;
  game: Game;
  score: { red: number; blue: number };
  participants: LanParticipant[];
  replayId: string | null;
  createdAt: string;
}

/**
 * Store one self-hosted match under the HOST's account, or return the row that is already
 * there. Prunes the host's oldest past `LAN_KEEP`.
 *
 * IDEMPOTENT ON `match_id` FOR THE ACCOUNT THAT FILED IT, and that is the whole point of the
 * id existing. The uploader is a
 * client draining a backlog over whatever connection a venue has, so the same match WILL be
 * offered twice — after a timeout that actually succeeded, after a reinstall, after two
 * tabs. `match_id` is UNIQUE, the existing row wins, and a second upload is a no-op rather
 * than a duplicate match in somebody's history.
 *
 * THE SCORE IS REPORTED BY A SERVER THE CLOUD DOES NOT TRUST, deliberately and permanently.
 * It is safe for the same structural reason `savePracticeRun` is: `lan_runs` is not reachable
 * from `record_leaderboard`, so nothing written here can move a board, a PB, a rank or an ELO.
 * Do not add a read path from here into any of those.
 */
/**
 * Somebody tried to file a match id that ALREADY BELONGS TO ANOTHER ACCOUNT.
 *
 * Its own error type, rather than a null return, because the two failures the caller has to
 * tell apart are "already yours, here it is" (idempotent, a 200 with the existing row) and
 * "already somebody else's" (a 409), and an absent row means neither. `/api/lan` turns this
 * into the 409; nothing else catches it.
 */
export class LanRunOwnedByAnother extends Error {
  constructor(readonly matchId: string) {
    super(`lan run ${matchId} was filed by another host`);
    this.name = 'LanRunOwnedByAnother';
  }
}

export async function saveLanRun(
  hostUserId: string,
  matchId: string,
  replay: Replay,
  score: { red: number; blue: number },
  participants: LanParticipant[],
  season: number,
  game?: Game,
): Promise<LanRunRow> {
  // CHECK BEFORE WRITING THE REPLAY, not after. `on conflict do nothing` would leave the
  // replay row we had already created with nothing pointing at it — the same missing
  // back-reference that makes the prune and the account-delete paths delete replays by hand.
  const already = await existingLanRun(matchId);
  if (already) {
    // IDEMPOTENT FOR THE OWNER, REFUSED FOR EVERYONE ELSE. Scoping the idempotence by host is
    // the whole difference between a retry and a theft: the check used to be on `match_id`
    // alone, so a second account posting the same id was handed the first account's row back
    // with a 200 — the claim quietly succeeded from the client's point of view, and the real
    // host's later upload was answered with somebody else's match. The id itself is a
    // capability now (it goes only to the host's socket; see `src/net/protocol.ts`), and this
    // is the check at the table that makes a leaked one fail loudly instead of silently.
    if (already.hostUserId !== hostUserId) throw new LanRunOwnedByAnother(matchId);
    return already;
  }

  const replayId = await saveReplay(replay, season, game);
  const rows = await q<{ id: string; created_at: string }>(
    `insert into lan_runs (match_id, host_user_id, game, balance_version, score, participants, replay_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (match_id) do nothing
     returning id, created_at`,
    [matchId, hostUserId, g(game), season, JSON.stringify(score), JSON.stringify(participants), replayId],
  );

  // lost a race with a concurrent upload of the SAME match — two of the host's own devices,
  // or a retry that overlapped its own first attempt. Drop the replay this call made, because
  // the row that won is pointing at a different one, and answer with the winner.
  if (!rows[0]) {
    await q(`delete from replays where id = $1`, [replayId]);
    const winner = await existingLanRun(matchId);
    // ...and the winner of that race is subject to the same ownership rule as a row that was
    // already there when we started: two of the HOST's devices is a retry, two accounts is not.
    if (winner && winner.hostUserId !== hostUserId) throw new LanRunOwnedByAnother(matchId);
    if (winner) return winner;
    throw new Error(`lan run ${matchId} neither inserted nor found`);
  }

  // PRUNE, and delete the pruned runs' replays with them — a replay has no back-reference to
  // the run that owns it, so dropping the row alone leaks the log.
  const stale = await q<{ replay_id: string | null }>(
    `delete from lan_runs
      where id in (
        select id from lan_runs
         where host_user_id = $1 and game = $2
         order by created_at desc
         offset $3
      )
      returning replay_id`,
    [hostUserId, g(game), LAN_KEEP],
  );
  const ids = stale.map((r) => r.replay_id).filter((x): x is string => !!x);
  if (ids.length) await q(`delete from replays where id = any($1::uuid[])`, [ids]);

  return { id: rows[0].id, matchId, hostUserId, game: g(game), score, participants, replayId, createdAt: rows[0].created_at };
}

/** the row for a match id, WHOEVER hosted it — the caller compares `hostUserId` itself. */
async function existingLanRun(matchId: string): Promise<LanRunRow | null> {
  const rows = await q<{
    id: string;
    match_id: string;
    host_user_id: string;
    game: Game;
    score: { red: number; blue: number };
    participants: LanParticipant[];
    replay_id: string | null;
    created_at: string;
  }>(
    `select id, match_id, host_user_id, game, score, participants, replay_id, created_at
       from lan_runs where match_id = $1`,
    [matchId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    matchId: r.match_id,
    hostUserId: r.host_user_id,
    game: r.game,
    score: r.score,
    participants: r.participants,
    replayId: r.replay_id,
    createdAt: r.created_at,
  };
}

/** a host's own self-hosted matches, newest first. Owner-only — see the API route. */
export async function listLanRuns(
  hostUserId: string,
  game?: Game,
  limit = LAN_KEEP,
): Promise<LanRunRow[]> {
  const rows = await q<{
    id: string;
    match_id: string;
    game: Game;
    score: { red: number; blue: number };
    participants: LanParticipant[];
    replay_id: string | null;
    created_at: string;
  }>(
    `select id, match_id, game, score, participants, replay_id, created_at
       from lan_runs
      where host_user_id = $1 and game = $2
      order by created_at desc
      limit $3`,
    [hostUserId, g(game), Math.min(LAN_KEEP, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    matchId: r.match_id,
    hostUserId, // every row this query can return is this host's own, by the WHERE above
    game: r.game,
    score: r.score,
    participants: r.participants,
    replayId: r.replay_id,
    createdAt: r.created_at,
  }));
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
  /** which physics solve produced this run (0039). Absent ⇒ '2d'. */
  physics?: string;
}

export async function submitRecord(r: RecordSubmit): Promise<string> {
  /**
   * THE WRITE-SIDE HALF OF THE SAME RULE, and the chokepoint version of it.
   *
   * `boardPhysics` keeps a 2D row off the board; this keeps it out of the TABLE. A record room
   * of a 3D-capable game is 3D (`Room.physics`), so a 2D container reaching here means the
   * server that produced it disagreed with this one — a stale process mid-deploy, or a caller
   * that invented a submission. Either way the run was not played on the solve the board is
   * made of, and accepting it would leave a row that every read then has to hide.
   *
   * THROWS rather than silently coercing the column: the score is real and the player was told
   * it counted, so the honest outcome is a refusal that shows up in the server log, not a row
   * quietly relabelled `'3d'` for a match that was not.
   */
  const want = livePhysics(g(r.game));
  if (want && (r.physics ?? '2d') !== want) {
    throw new Error(
      `record refused: ${g(r.game)} runs on ${want} physics, this one is ${r.physics ?? '2d'}`,
    );
  }
  const rows = await q<{ id: string }>(
    `insert into records (user_id, partner_id, mode, drivetrain, score, balance_version, replay_id, config, game, physics)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
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
      r.physics === '3d' ? '3d' : '2d',
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
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
  /** the PARTNER's badge on a duo row. A duo record is two people's run and both
   *  names are printed, so both names carry their own badge. */
  partnerSupporter?: boolean;
  partnerRole?: StaffRole;
  /** which solve produced this run (0039). A pre-0039 row reads `'2d'` because that is what it
   *  was; the board shows it as a chip beside the name so two eras on one board are legible. */
  physics?: string;
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
  /**
   * WHICH ERA (migration 0039). Absent ⇒ `boardPhysics(game)`, i.e. `'3d'` for a game that has
   * two solves and no filter at all for one that does not. The board is not a place two eras
   * meet (owner ruling, 2026-09-18) — see `boardPhysics`.
   *
   * Still an ARGUMENT because the admin console and the tests have a legitimate reason to ask
   * for the other era; it is no longer something a public request can set.
   *
   * ⚠️ **THE FILTER IS INSIDE `best`, NOT OUTSIDE IT**, and that placement is the whole point:
   * `best` is one row per player, so filtering after it would show a player's 2D personal best
   * and then hide it, leaving them off a 3D board they have a legitimate 3D score on. Filtering
   * first makes the board "each player's best 3D run", which is what the board now means.
   */
  physics?: '2d' | '3d';
}): Promise<BoardRow[]> {
  const params: unknown[] = [opts.balanceVersion, opts.mode, g(opts.game)];
  let dtFilter = '';
  if (opts.drivetrain && opts.drivetrain !== 'overall') {
    params.push(opts.drivetrain);
    dtFilter = `and r.drivetrain = $${params.length}`;
  }
  let physFilter = '';
  const phys = opts.physics ?? (await boardPhysics(g(opts.game), opts.balanceVersion));
  if (phys) {
    params.push(phys);
    physFilter = `and r.physics = $${params.length}`;
  }
  params.push(opts.limit ?? 100);
  return q<BoardRow>(
    `with best as (
       select distinct on (r.user_id)
         r.user_id, r.partner_id, r.score, r.replay_id, r.created_at, r.config, r.physics
       from records r
       where r.balance_version = $1 and r.mode = $2 and r.game = $3 ${dtFilter} ${physFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.user_id as "userId", p.handle, p.username, ${badgeCols('p.')},
            b.partner_id as "partnerId",
            pp.handle as "partnerHandle", pp.username as "partnerUsername",
            ${badgeCols('pp.', 'partner')},
            b.score, b.replay_id as "replayId", b.created_at as "createdAt", b.config, b.physics
     from best b
       join profiles p on p.user_id = b.user_id
       left join profiles pp on pp.user_id = b.partner_id
     -- user_id LAST: a tie on score AND on the instant it was set is decided the same way on
     -- every read, so an award computed off this board (recordSeasonGrants) agrees with it
     order by b.score desc, b.created_at asc, b.user_id
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
  //
  // ERA-SCOPED like the board it is compared against (`boardPhysics`): a PB that counted an
  // old 2D run would tell a player their first 3D run was not a personal best, against a row
  // they cannot see on any board and can never beat on this solve.
  const overall = drivetrain === 'overall';
  const phys = await boardPhysics(g(game), balanceVersion);
  const params: unknown[] = [userId, mode, balanceVersion, g(game)];
  if (!overall) params.push(drivetrain);
  const dtFilter = overall ? '' : `and drivetrain = $${params.length}`;
  let physFilter = '';
  if (phys) {
    params.push(phys);
    physFilter = `and physics = $${params.length}`;
  }
  const rows = await q<{ score: number | null }>(
    `select max(score) as score from records
     where user_id = $1 and mode = $2 and balance_version = $3 and game = $4
       ${dtFilter} ${physFilter}`,
    params,
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
  // ERA-SCOPED, and INSIDE `best` — same rule and same placement as `recordLeaderboard`, so
  // the "#3 of 57" a player is shown after a run is a position on the board they can go and
  // look at rather than a rank over a population the board does not contain.
  const overall = drivetrain === 'overall';
  const phys = await boardPhysics(g(game), balanceVersion);
  // $4 is always REFERENCED and typed: an overall read (a mixed-drivetrain duo) used to leave it
  // out of the SQL, and Postgres refuses a parameter it cannot type, so that rank threw
  const rows = await q<{ rank: number; total: number }>(
    `with best as (
       select user_id, max(score) as s from records
       where balance_version = $1 and mode = $2 and game = $5
         and ($4::text is null or drivetrain = $4)
         ${phys ? 'and physics = $6' : ''}
       group by user_id
     ), me as (select s from best where user_id = $3)
     select
       (select count(*) from best)::int as total,
       (1 + (select count(*) from best where s > (select s from me)))::int as rank`,
    phys
      ? [balanceVersion, mode, userId, overall ? null : drivetrain, g(game), phys]
      : [balanceVersion, mode, userId, overall ? null : drivetrain, g(game)],
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
  /** rows to skip — the console pages through a name that matches a lot of people
   *  rather than silently showing the first 25 and pretending that is all of them */
  offset = 0,
): Promise<
  {
    userId: string;
    handle: string;
    username: string | null;
    supporter: boolean;
    supporterUntil: string | null;
    /** a Ko-fi payer address is linked, so this account renews automatically */
    autoRenews: boolean;
    role: StaffRole | null;
  }[]
> {
  return q(
    // DELIBERATELY the PAID predicate, not the entitled one the rest of the file
    // uses. This is the admin console's grant/revoke row: an admin deciding
    // whether to add months needs to see the membership actually bought, and
    // showing every colleague as a supporter with no expiry would be misleading
    // exactly where precision matters. `role` is surfaced separately instead.
    `select user_id as "userId", handle, username, role,
            (supporter_until is not null and supporter_until > now()) as supporter,
            supporter_until as "supporterUntil",
            (kofi_email is not null) as "autoRenews"
       from profiles
      where handle ilike $1 escape '\\' or user_id = $2 or username = lower($2)
      order by handle, user_id limit $3 offset $4`,
    // ESCAPED. A bare `%` in the box matched every profile on the service in one
    // request — the same hole `searchPublicProfiles` closed on the public side, and a
    // worse one here because these rows carry the membership and the staff role.
    // `order by` is tie-broken on `user_id` so paging cannot show one row twice and skip
    // another: `handle` is not unique and two people called "Player" have no stable order
    // between pages without it.
    [`%${query.replace(/[\\%_]/g, '\\$&')}%`, query, limit, Math.max(0, Math.floor(offset))],
  );
}

// ------------------------------------------------------ account deletion ----
/**
 * Delete an account and everything attached to it.
 *
 * The privacy policy promises this, so it has to be a real code path rather than
 * a manual `psql` session someone half-remembers. Most tables hang off
 * `profiles(user_id) on delete cascade` (presets, records, ELO, match
 * participation, invites, friendships, blocks, presence), so deleting the profile
 * row does the bulk of the work in one statement.
 *
 * Three things do NOT cascade and are handled explicitly, in this order:
 *
 *  - `replays` has no user column at all. FOUR tables point at it — `records`,
 *    `matches`, `practice_runs` and `lan_runs` — and every one of those FKs is
 *    `on delete set null`, so cascading their owning rows away first would orphan
 *    the replay permanently. They are collected and deleted BEFORE the profile goes.
 *    The `matches` arm reaches them through `match_participants`, and THE MATCH ROW
 *    ITSELF IS KEPT: it holds no personal data (mode, season, ranked, date) and a
 *    co-participant reads it in their own history.
 *    ⚠️ THE ACCEPTED COST, stated because it is invisible from here: deleting one
 *    account takes that replay out of EVERY other participant's copy of the match.
 *    They keep the result, the score, the ELO delta and the date; the Watch button
 *    goes dead. `userRecentMatches` — the moderation drill-down, whose own comment
 *    says a cheating report "is unjudgeable from text; the moderator has to watch
 *    the match" — loses it too, so an OPEN `score_reports` row against that match
 *    loses its evidence permanently and silently, which also means deleting your
 *    account destroys the case against you. A departing account's privacy request
 *    still beats a stranger's rewatch; that is the trade, not an oversight.
 *  - `elo_history` deliberately has no foreign key (it is a per-season snapshot
 *    that must survive a season roll), so it needs its own delete.
 *  - `kofi_payments.claimed_by` is `on delete set null`, which is correct — the
 *    payment record is financial history and outlives the account — but the payer
 *    EMAIL is personal data, so it is scrubbed here rather than left behind.
 *
 * Returns false if there was no such profile.
 */
export async function deleteAccount(userId: string): Promise<boolean> {
  return tx(async (query) => {
    const exists = await query<{ user_id: string }>(
      `select user_id from profiles where user_id = $1`,
      [userId],
    );
    if (!exists[0]) return false;

    // replays first — see the note above about the missing back-reference. PRACTICE runs are
    // in this list for the same reason: `practice_runs` cascades away with the profile, which
    // would strand the logs it pointed at. So does `lan_runs`, keyed on the HOST who uploaded
    // it — a self-hosted match belongs to whoever ran it, and leaves with them.
    await query(
      `delete from replays
        where id in (select replay_id from records
                      where user_id = $1 and replay_id is not null
                     union all
                     select replay_id from practice_runs
                      where user_id = $1 and replay_id is not null
                     union all
                     select replay_id from lan_runs
                      where host_user_id = $1 and replay_id is not null
                     union all
                     /* VERSUS MATCHES. The only path from a person to a match replay is
                        match_participants, and this is the arm that was missing: every
                        versus replay the account ever played survived its own deletion,
                        reachable by nothing but the season purge. It MUST stay inside this
                        first statement -- match_participants.user_id is on delete cascade,
                        so after the delete from profiles below the join row is gone and this
                        subselect silently finds nothing. The matches row stays; see above. */
                     select replay_id from matches
                      where replay_id is not null
                        and id in (select match_id from match_participants
                                    where user_id = $1))`,
      [userId],
    );
    await query(`delete from elo_history where user_id = $1`, [userId]);
    await query(
      `update kofi_payments set email = null where claimed_by = $1`,
      [userId],
    );
    await query(`delete from profiles where user_id = $1`, [userId]);
    return true;
  });
}


// ------------------------------------------------------ data portability ----
/**
 * EVERYTHING THIS DATABASE HOLDS ABOUT ONE ACCOUNT, as one JSON document.
 *
 * The twin of `deleteAccount` above, and deliberately written next to it: the two answer the
 * same question from opposite ends, so a table added to one list and not the other is visible
 * in a single screenful. The privacy policy promises portability alongside deletion, and a
 * promise kept by a mailbox is not the same as one kept by a button.
 *
 * TWO RULES ABOUT OTHER PEOPLE, because an export is the easiest place in an app to hand
 * somebody a copy of data that is not theirs:
 *
 *  1. **Only rows keyed to this user id**, plus the public facts of matches they played in.
 *     A versus match involves three other accounts; this export carries the caller's own
 *     participant row and the match's final score, and NOT the other players — not their ids,
 *     not their names, not their ratings. That is a real loss of context (you cannot see who
 *     you beat) and it is the right trade: match history is already on screen in the app for
 *     anyone who wants to look, and a downloadable file is a thing that gets forwarded.
 *  2. **Names only where the caller already sees them in the app.** Friends, blocks and
 *     invites name the other party by handle and username — both public, both already on
 *     screen in the friends rail, and the list is meaningless without them.
 *
 * REPLAY BODIES ARE NOT IN HERE, by id and metadata only. One replay is tens of kilobytes of
 * per-tick input log; forty of them would make this a multi-megabyte response built in memory
 * on a machine whose real job is running match loops. Every one of those ids is individually
 * downloadable from the app already, which is the better shape for a thing that large.
 *
 * Returns `null` for an account with no profile row — including one that has just been
 * deleted, which is what makes "my export after deletion" a 404 rather than an empty file
 * that looks like a successful export of nothing.
 */
export interface AccountExport {
  /** bumped if the SHAPE changes incompatibly, so a file can be read years later */
  format: number;
  exportedAt: string;
  userId: string;
  /** what is deliberately absent, stated in the file rather than only in the policy */
  notes: string[];
  account: Record<string, unknown>;
  settings: unknown;
  robotPresets: Record<string, unknown>[];
  records: Record<string, unknown>[];
  practiceRuns: Record<string, unknown>[];
  lanRuns: Record<string, unknown>[];
  matches: Record<string, unknown>[];
  ranked: { ratings: Record<string, unknown>[]; history: Record<string, unknown>[] };
  standing: Record<string, unknown> | null;
  standingEvents: Record<string, unknown>[];
  playtime: Record<string, unknown>[];
  friends: {
    friends: Record<string, unknown>[];
    requestsReceived: Record<string, unknown>[];
    requestsSent: Record<string, unknown>[];
    blocked: Record<string, unknown>[];
    invitesReceived: Record<string, unknown>[];
    invitesSent: Record<string, unknown>[];
  };
  replays: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  /** the reward ledger (0048): every grant, with its reason and what it delivered */
  rewards: Record<string, unknown>[];
  /** access groups (0051) — the group and when; never who granted it (another account's id) */
  accessGroups: Record<string, unknown>[];
}

export async function exportAccount(userId: string): Promise<AccountExport | null> {
  const prof = await q<{
    handle: string;
    username: string | null;
    created_at: string;
    updated_at: string;
    role: string | null;
    settings: unknown;
    supporter_until: string | null;
    kofi_email: string | null;
    replays_public: boolean;
    terms_version: string | null;
    terms_accepted_at: string | null;
  }>(
    `select handle, username, created_at, updated_at, role, settings, supporter_until,
            kofi_email, replays_public, terms_version, terms_accepted_at
       from profiles where user_id = $1`,
    [userId],
  );
  const p = prof[0];
  if (!p) return null;

  // NAMED PARTY LOOKUPS. One join per relation rather than one query per friend: these lists
  // are small (a friends list is dozens, not thousands) but they are still four of them, and
  // N+1 on an authenticated route is how a rate limit ends up being the only thing between a
  // button and a Neon bill.
  const named = (
    rows: { handle: string; username: string | null; created_at: string }[],
  ): Record<string, unknown>[] =>
    rows.map((r) => ({ handle: r.handle, username: r.username, since: r.created_at }));

  const [
    presets, records, practice, lan, matches, ratings, history, standing, events, activity,
    friends, reqIn, reqOut, blocked, invIn, invOut, payments,
  ] = await Promise.all([
    q<Record<string, unknown>>(
      `select slot, name, spec, updated_at from robot_presets where user_id = $1 order by slot`,
      [userId],
    ),
    // `partner_id` is another account's id, so it is reported as a BOOLEAN — "this was a duo
    // run" is the fact the owner needs; who with is the other person's row.
    q<Record<string, unknown>>(
      `select id, game, mode, drivetrain, score, balance_version, replay_id, physics,
              created_at, partner_id is not null as was_duo, config
         from records where user_id = $1 order by created_at desc`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select id, game, score, ticks, balance_version, replay_id, physics, view, created_at
         from practice_runs where user_id = $1 order by created_at desc`,
      [userId],
    ),
    // `participants` is the roster the HOST uploaded with the match, and is display text they
    // already see in their own self-hosted replay list.
    q<Record<string, unknown>>(
      `select id, match_id, game, score, participants, replay_id, created_at
         from lan_runs where host_user_id = $1 order by created_at desc`,
      [userId],
    ),
    // ⚠️ THE CALLER'S OWN PARTICIPANT ROW AND THE MATCH'S OWN FACTS, AND NOTHING ELSE. No
    // second join back to `match_participants`, deliberately: adding one is how the other
    // three players in a 2v2 would end up in somebody's download.
    q<Record<string, unknown>>(
      `select m.id as match_id, m.game, m.mode, m.ranked, m.physics, m.balance_version,
              m.replay_id, m.created_at,
              mp.alliance, mp.drivetrain, mp.score, mp.won,
              mp.rating_before, mp.rating_after
         from match_participants mp join matches m on m.id = mp.match_id
        where mp.user_id = $1 order by m.created_at desc`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select game, mode, act, rating, rd, vol, games, updated_at
         from elo_ratings where user_id = $1 order by game, mode, act`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select game, mode, balance_version, rating, rd, vol, games, updated_at
         from elo_history where user_id = $1 order by game, mode, balance_version`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select score, restricted_until, healed_at, updated_at
         from account_standing where user_id = $1`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select kind, points, score_after, cooldown_min, rating_charge, game, mode, at
         from standing_events where user_id = $1 order by at desc`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select game, games, seconds, updated_at from user_activity where user_id = $1 order by game`,
      [userId],
    ),
    // friendships store ONE row per unordered pair, so "the other one" is whichever column
    // is not the caller (see migration 0016's `user_low < user_high` check).
    q<{ handle: string; username: string | null; created_at: string }>(
      `select pr.handle, pr.username, f.created_at
         from friendships f
         join profiles pr
           on pr.user_id = case when f.user_low = $1 then f.user_high else f.user_low end
        where f.user_low = $1 or f.user_high = $1
        order by f.created_at`,
      [userId],
    ),
    q<{ handle: string; username: string | null; created_at: string }>(
      `select pr.handle, pr.username, r.created_at
         from friend_requests r join profiles pr on pr.user_id = r.from_user_id
        where r.to_user_id = $1 order by r.created_at`,
      [userId],
    ),
    q<{ handle: string; username: string | null; created_at: string }>(
      `select pr.handle, pr.username, r.created_at
         from friend_requests r join profiles pr on pr.user_id = r.to_user_id
        where r.from_user_id = $1 order by r.created_at`,
      [userId],
    ),
    q<{ handle: string; username: string | null; created_at: string }>(
      `select pr.handle, pr.username, b.created_at
         from friend_blocks b join profiles pr on pr.user_id = b.blocked_id
        where b.blocker_id = $1 order by b.created_at`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select pr.handle, pr.username, i.room, i.game, i.kind, i.record, i.created_at
         from room_invites i join profiles pr on pr.user_id = i.from_user_id
        where i.to_user_id = $1 order by i.created_at`,
      [userId],
    ),
    q<Record<string, unknown>>(
      `select pr.handle, pr.username, i.room, i.game, i.kind, i.record, i.created_at
         from room_invites i join profiles pr on pr.user_id = i.to_user_id
        where i.from_user_id = $1 order by i.created_at`,
      [userId],
    ),
    // ⚠️ `email` IS NOT SELECTED, and that is not squeamishness. The payer address on this row
    // is the caller's own, so including it would be defensible — but a payment row survives
    // account deletion with the email nulled (see `deleteAccount`), and a route that reads the
    // column at all is one refactor away from reading it for the wrong `claimed_by`. The
    // address is on the caller's own Ko-fi receipt, which is a better source than this table.
    q<Record<string, unknown>>(
      `select transaction_id, kind, amount, currency, is_subscription, months, claimed_at
         from kofi_payments where claimed_by = $1 order by claimed_at`,
      [userId],
    ),
  ]);

  /**
   * REPLAY IDS AND WHAT THEY BELONG TO, gathered from the three tables that point at one.
   *
   * Read off the rows already fetched rather than with a fourth query, and this is the same
   * union `deleteAccount` deletes by — a replay has no back-reference to its owner, so the
   * only way to know which of them are yours is to ask the things that reference them.
   */
  const replayRefs: Record<string, unknown>[] = [];
  const pushRef = (kind: string, rows: Record<string, unknown>[]): void => {
    for (const r of rows) {
      if (typeof r.replay_id === 'string') {
        replayRefs.push({ id: r.replay_id, kind, game: r.game ?? null, at: r.created_at ?? null });
      }
    }
  };
  pushRef('record', records);
  pushRef('practice', practice);
  pushRef('lanMatch', lan);
  // A versus replay is shared with the other players and is released only when EVERY one of
  // them opts in (migration 0038), so it is listed as a match replay rather than as "yours".
  pushRef('match', matches);

  return {
    format: 1,
    exportedAt: new Date().toISOString(),
    userId,
    notes: [
      'Only rows belonging to this account are included. Other players in a match you played are deliberately absent — their names, ids and ratings are theirs, not yours.',
      'Replays are listed by id and metadata. The input log itself is tens of kilobytes per match and is downloadable one at a time from the app.',
      'Your sign-in identity (email address and password) lives with the authentication provider, not in this database, so it is not in this file.',
      'Settings, theme and other on-device values are in your browser, not here. The privacy page lists every key and your browser can show you their contents.',
    ],
    account: {
      handle: p.handle,
      username: p.username,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      staffRole: p.role,
      supporterUntil: p.supporter_until,
      supporterRenewalLinked: !!p.kofi_email,
      replaysPublic: p.replays_public,
      termsVersion: p.terms_version,
      termsAcceptedAt: p.terms_accepted_at,
    },
    settings: p.settings ?? null,
    robotPresets: presets,
    records,
    practiceRuns: practice,
    lanRuns: lan,
    matches,
    ranked: { ratings, history },
    standing: standing[0] ?? null,
    standingEvents: events,
    playtime: activity,
    friends: {
      friends: named(friends),
      requestsReceived: named(reqIn),
      requestsSent: named(reqOut),
      blocked: named(blocked),
      invitesReceived: invIn,
      invitesSent: invOut,
    },
    replays: replayRefs,
    payments,
    // every reward the ledger has for this account, pending and revoked ones included — the
    // file answers "what was I given, and why", which is the whole of what the ledger holds
    rewards: await q<Record<string, unknown>>(
      `select grant_key, source, reason, items, silent, created_at, claimed_at, revoked_at
         from reward_grants where user_id = $1 order by created_at`,
      [userId],
    ),
    accessGroups: await q<Record<string, unknown>>(
      `select grp as "group", granted_at as "grantedAt" from access_members where user_id = $1 order by granted_at`,
      [userId],
    ),
  };
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

/**
 * The ACT a game's ratings currently live on, CACHED per process.
 *
 * Resolving it is two queries (`currentSeasonNumber` then `actForSeason`) and neither
 * was memoized, so reading one player's rating cost THREE sequential round trips. That
 * was tolerable while the only caller was `introElo` — once per roster entry, after a
 * match had already been paired — and is not once the matchmaker reads a rating per
 * JOIN. Two of the three trips are the same answer for everybody.
 *
 * A TTL rather than a permanent memo because an admin can roll an act at runtime
 * (`startNewSeason`) with no redeploy; a minute is well inside the tolerance for that
 * and still collapses a queue's worth of joins onto one lookup. Copies the
 * `userRoomCache` shape below: a module-level `{at, val}` with a millisecond constant.
 *
 * NOT a rating cache. Ratings are per-player and change every match, and `server/db/
 * pool.ts` is explicit that Neon bills CU-hours as wall-clock time AWAKE — so a cache
 * that invites a per-tick read loop would convert a bursty workload into a permanent
 * bill. This caches the part that is shared and nearly static, and nothing else.
 */
const ACT_TTL_MS = 60_000;
const actCache = new Map<string, { at: number; act: number }>();

export async function actFor(game: Game | undefined, now = Date.now()): Promise<number> {
  const key = g(game);
  const hit = actCache.get(key);
  if (hit && now - hit.at < ACT_TTL_MS) return hit.act;
  const bv = await currentSeasonNumber(BALANCE_VERSION, game);
  const act = await actForSeason(bv, game);
  actCache.set(key, { at: now, act });
  return act;
}

/** drop the memo — for tests, and for an admin act roll that should take effect now */
export function clearActCache(): void {
  actCache.clear();
}

/**
 * A player's rating AND how many games they have on that board, in ONE query.
 *
 * `getRating` alone cannot answer "should this player be skill-matched?", because its
 * `?? 1000` is ambiguous: it reads the same for "never played this board" and "played
 * to exactly 1000". The placement flag is games-based (`games < PLACEMENT_GAMES`, see
 * src/config.ts — it REPLACED an older RD-based test that stayed set for dozens of
 * games in a young pool), and `games` is in neither existing select.
 *
 * `placed` false means UNKNOWN SKILL, which a matcher must treat as "do not gate",
 * never as "assume 1000" — an unplaced player has no rating to match on and still has
 * to get a game.
 */
export async function getSkill(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  game?: Game,
): Promise<{ rating: number; games: number; placed: boolean }> {
  const rows = await q<{ rating: number; games: number }>(
    `select rating, games from elo_ratings
     where user_id = $1 and mode = $2 and act = $3 and game = $4`,
    [userId, mode, act, g(game)],
  );
  const r = rows[0];
  return {
    rating: r?.rating ?? 1000,
    games: r?.games ?? 0,
    placed: (r?.games ?? 0) >= PLACEMENT_GAMES,
  };
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
/**
 * Every named player's rating on one board, in ONE query.
 *
 * `getRatingFull` is per-user, and `persistVersusMatch` called it in a loop — four sequential
 * round trips at the end of a 2v2 before anything else could happen. The reads are completely
 * independent of each other (Glicko-2's sequencing is in the COMPUTE, which takes the whole
 * set at once and runs after this), so there was never a reason for them to be serial.
 *
 * Returns the same defaults `getRatingFull` does for a player with no row yet — a placement
 * player and an absent row are the same thing here, and the caller cannot tell them apart in
 * the per-user version either.
 */
export async function getRatingsFull(
  userIds: string[],
  mode: '1v1' | '2v2',
  act: number,
  game?: Game,
): Promise<Map<string, { rating: number; rd: number; vol: number }>> {
  const out = new Map<string, { rating: number; rd: number; vol: number }>();
  const ids = [...new Set(userIds.filter(Boolean))];
  for (const id of ids) out.set(id, { rating: 1000, rd: 350, vol: 0.06 });
  if (!ids.length) return out;
  const rows = await q<{ user_id: string; rating: number; rd: number; vol: number }>(
    `select user_id, rating, rd, vol from elo_ratings
      where user_id = any($1::text[]) and mode = $2 and act = $3 and game = $4`,
    [ids, mode, act, g(game)],
  );
  for (const r of rows) out.set(r.user_id, { rating: r.rating, rd: r.rd, vol: r.vol });
  return out;
}

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

/**
 * Charge RATING for a behaviour offence — the LAST rung of the standing escalation, and the
 * only place behaviour is ever allowed to touch the skill number (see src/standing.ts: it is
 * zero above Probation).
 *
 * Deliberately NOT `upsertRating`, for two reasons that both matter:
 *
 *  - `games` is NOT incremented. Abandoning a match is not playing one; counting it would
 *    let a player finish placements — or shrink toward "established" — by quitting.
 *  - `rd` and `vol` are NOT touched. Rating deviation states how well we know someone's
 *    SKILL, and none of this says anything about that. Shrinking RD would mean misbehaving
 *    made the system MORE confident in you, which is backwards; growing it would hand the
 *    offender bigger swings to climb back with, which rewards the behaviour.
 *
 * The rating is floored, so a run of charges cannot print an absurd number. Returns what was
 * actually stored — at the floor that differs from the nominal charge, and the player should
 * be told the truth rather than the sticker price.
 */
export async function chargeRatingForBehaviour(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  charge: number,
  floor: number,
  game?: Game,
): Promise<{ before: number; after: number }> {
  const cur = await getRatingFull(userId, mode, act, game);
  const before = Math.round(cur.rating);
  const after = Math.max(floor, before - Math.max(0, Math.round(charge)));
  if (after === before) return { before, after };
  // upsert WITHOUT touching games/rd/vol (see above). A player with no rating row on this
  // board yet gets one seeded at the charged value, games still 0.
  await q(
    `insert into elo_ratings (user_id, mode, act, game, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, 0)
     on conflict (user_id, mode, game, act)
       do update set rating = excluded.rating, updated_at = now()`,
    [userId, mode, act, g(game), after, cur.rd, cur.vol],
  );
  return { before, after };
}

/**
 * The ranked board this player most recently played on.
 *
 * Used when a behaviour charge has no board of its own — a moderator upholding reports days
 * after the fact. Charging their most recent board puts the penalty where the player will
 * actually see it, instead of on a game/mode they may never open. Null ⇒ they have no ranked
 * history at all, and the charge is dropped rather than invented.
 */
export async function lastRankedBoard(
  userId: string,
): Promise<{ mode: '1v1' | '2v2'; game: Game; act: number } | null> {
  const rows = await q<{ mode: string; game: string; act: number }>(
    `select mode, game, act from elo_ratings
      where user_id = $1 order by updated_at desc limit 1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    mode: r.mode === '2v2' ? '2v2' : '1v1',
    game: coerceGameId(r.game) as Game,
    act: Number(r.act ?? 0),
  };
}

// ----------------------------------------------------- account standing ------

export interface StandingSnapshot {
  score: number;
  /** epoch ms the ranked queue reopens, or null */
  restrictedUntil: number | null;
}

const snap = (r: { score: number; restricted_until: string | null } | undefined): StandingSnapshot => ({
  score: clampScore(Number(r?.score ?? STANDING_MAX)),
  restrictedUntil: r?.restricted_until ? new Date(r.restricted_until).getTime() : null,
});

/**
 * This account's standing, with TIME HEALING applied on read.
 *
 * The heal is lazy rather than a scheduled job, and it advances `healed_at` by the same
 * whole days it credits — in ONE statement, so two concurrent reads cannot both credit the
 * same day. A cron would be a second thing to deploy and a second thing to be wrong about a
 * player's number.
 *
 * Creates the row on first sight: a player with no row has never offended, which is exactly
 * a full score, and seeding it here means every later write is a plain update.
 */
export async function getStanding(userId: string): Promise<StandingSnapshot> {
  /**
   * READ-ONLY FAST PATH, because this is not really a write.
   *
   * The transaction below exists for two rare cases: an account with no row yet, and one
   * whose healing is actually due. In the ordinary case — a row that exists, at full score or
   * healed within the day — the INSERT and the UPDATE are both no-ops and the whole thing
   * collapses to the SELECT at the end. Paying `BEGIN` + three statements + `COMMIT` for that
   * is five round trips holding a pooled connection, and `DB_POOL_MAX` defaults to 5.
   *
   * It matters because this is on a READ path in two places: `GET /api/standing`, and
   * `rankedLock` — which runs on every ranked queue attempt, i.e. the moment a burst of
   * players all press the same button.
   *
   * `heal_due` is computed by the same predicate the UPDATE uses, so the fast path is taken
   * only when that UPDATE would have changed nothing. It is no more raceable than the
   * transaction was: a concurrent charge could always land between the read and its caller.
   */
  const fast = await q<{ score: number; restricted_until: string | null; heal_due: boolean }>(
    `select score, restricted_until,
            (score < $2::int and now() - healed_at >= interval '1 day') as heal_due
       from account_standing where user_id = $1`,
    [userId, STANDING_MAX],
  );
  if (fast.length && !fast[0].heal_due) return snap(fast[0]);

  return tx(async (query) => {
    await query(
      `insert into account_standing (user_id) values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    const healedRows = await query<{ score: number; restricted_until: string | null }>(
      `update account_standing
          set score = least($2::int, score + (floor(extract(epoch from (now() - healed_at)) / 86400)::int * $3::int)),
              healed_at = healed_at + (floor(extract(epoch from (now() - healed_at)) / 86400) || ' days')::interval,
              updated_at = now()
        where user_id = $1
          and score < $2::int
          and now() - healed_at >= interval '1 day'
        returning score, restricted_until`,
      [userId, STANDING_MAX, HEAL_PER_DAY],
    );
    if (healedRows.length) return snap(healedRows[0]);
    const rows = await query<{ score: number; restricted_until: string | null }>(
      `select score, restricted_until from account_standing where user_id = $1`,
      [userId],
    );
    return snap(rows[0]);
  });
}

/** standings for a set of accounts, for the moderation queue. Missing rows are simply
 *  absent — the caller reads that as a full score rather than paying for a write. */
export async function standingsFor(userIds: string[]): Promise<Record<string, StandingSnapshot>> {
  if (!userIds.length) return {};
  const rows = await q<{ user_id: string; score: number; restricted_until: string | null }>(
    `select user_id, score, restricted_until from account_standing where user_id = any($1::text[])`,
    [userIds],
  );
  const out: Record<string, StandingSnapshot> = {};
  for (const r of rows) out[r.user_id] = snap(r);
  return out;
}

/** How many offences of ONE kind this player has inside the escalation window. Counted by
 *  TIME alone — not per season or per board — so a season boundary cannot forgive a pattern
 *  mid-window, and switching between the 1v1 and 2v2 queues does not reset it. */
export async function recentStandingCount(userId: string, kind: string, hours: number): Promise<number> {
  const rows = await q<{ n: number }>(
    // VOIDED ROWS DO NOT COUNT. A pardon that left the escalation intact would be a pardon in
    // name only: the points come back and the next offence of that kind is still priced as a
    // second one, with the longer lock and the rating charge that go with it (migration 0036).
    `select count(*)::int as n from standing_events
      where user_id = $1 and kind = $2 and at > now() - $3::interval and voided_at is null`,
    [userId, kind, `${Math.max(1, Math.floor(hours))} hours`],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Commit one offence: the new score and lock, plus a LEDGER row.
 *
 * Both in one transaction because they are one fact. A score that moved with no event to
 * explain it is exactly the thing that makes a penalty system feel arbitrary, and it is the
 * first thing a player asks a moderator about.
 *
 * `healed_at` is reset to now: healing measures time since the last offence, so an offence
 * has to restart that clock or a player could bank idle days and spend them immediately.
 */
export async function writeStandingEvent(
  userId: string,
  v: StandingVerdict,
  ctx: { game?: Game; mode?: string; roomCode?: string } = {},
): Promise<void> {
  await tx(async (query) => {
    await query(
      `insert into account_standing (user_id, score, restricted_until, healed_at, updated_at)
       values ($1, $2, $3, now(), now())
       on conflict (user_id) do update
         set score = excluded.score,
             restricted_until = greatest(
               coalesce(account_standing.restricted_until, to_timestamp(0)),
               coalesce(excluded.restricted_until, to_timestamp(0))
             ),
             healed_at = now(),
             updated_at = now()`,
      [userId, v.scoreAfter, v.restrictedUntil ? new Date(v.restrictedUntil).toISOString() : null],
    );
    await query(
      `insert into standing_events (user_id, kind, points, score_after, cooldown_min, rating_charge, game, mode, room_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, v.kind, v.points, v.scoreAfter, v.cooldownMin, v.ratingCharge,
       ctx.game ? g(ctx.game) : null, ctx.mode ?? null, ctx.roomCode ?? null],
    );
  });
}

/**
 * Credit a completed, clean ranked match.
 *
 * Only touches rows that EXIST and are below the maximum: a player who has never offended
 * needs no row, and creating one for every finished match would write a table's worth of
 * "100" for nothing. The restriction clock is untouched — serving a cooldown and playing
 * your way back are separate things, and a match played before the lock lands should not
 * shorten it.
 */
export async function healStandingForCleanMatch(userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  await q(
    `update account_standing
        set score = least($2::int, score + $3::int), updated_at = now()
      where user_id = any($1::text[]) and score < $2::int`,
    [userIds, STANDING_MAX, HEAL_PER_CLEAN_MATCH],
  );
}

/** the ledger for one player, newest first — the player's own "why" and the moderator's
 *  history in the same shape */
export async function listStandingEvents(userId: string, limit = 20): Promise<StandingEventRow[]> {
  const rows = await q<{
    id: string; kind: string; points: number; score_after: number;
    cooldown_min: number; rating_charge: number; game: string | null; at: string;
    voided_at: string | null; note: string | null;
  }>(
    // VOIDED ROWS ARE STILL RETURNED, and shown struck through. A pardoned player needs to see
    // that their appeal was acted on, and the next moderator needs to see that it was.
    `select id, kind, points, score_after, cooldown_min, rating_charge, game, at, voided_at, note
       from standing_events where user_id = $1 order by at desc limit $2`,
    [userId, Math.min(100, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    points: Number(r.points),
    scoreAfter: Number(r.score_after),
    cooldownMin: Number(r.cooldown_min),
    ratingCharge: Number(r.rating_charge),
    game: r.game,
    at: r.at,
    voidedAt: r.voided_at,
    note: r.note,
  }));
}

export interface StandingEventRow {
  id: string;
  kind: string;
  points: number;
  scoreAfter: number;
  cooldownMin: number;
  ratingCharge: number;
  game: string | null;
  at: string;
  /** set when a moderator pardoned this offence: it no longer escalates and is shown struck
   *  through, but it is still on the record (migration 0036) */
  voidedAt?: string | null;
  /** a moderator's reason for a manual adjustment. Shown to the PLAYER — an edit they cannot
   *  see the reason for is the arbitrary moderation this whole system is written against. */
  note?: string | null;
}

/**
 * MODERATOR EDITS to one account's standing — the manual half of a system that is otherwise
 * charged entirely by a server watching sockets.
 *
 * ONE function rather than three endpoints, because the three things a moderator does here are
 * one fact: void the offences, put the score back, lift the lock. Split apart, a pardon can
 * land half-applied — points restored while the queue stays shut, or a lock lifted that the
 * next offence immediately reinstates at the old rung because the ledger still counts what was
 * supposedly forgiven.
 *
 * `score` is an ABSOLUTE target rather than a delta, because that is the decision actually
 * being made ("put them back to 100"). The ledger row then records the SIGNED difference,
 * which is the form the player reads (src/standing.ts `standingDelta`).
 */
export async function adminEditStanding(
  userId: string,
  adminId: string,
  opts: {
    /** absolute target 0..STANDING_MAX; omitted leaves the score where it is */
    score?: number;
    /** void every offence still counting, so escalation forgets them */
    pardonAll?: boolean;
    /** void exactly these ledger rows */
    pardonIds?: string[];
    /** false clears the ranked lock; a number sets one that many minutes out; omitted
     *  leaves a cooldown somebody is legitimately serving alone */
    lock?: false | number;
    /** why, in the moderator's own words — stored on the ledger row the player reads */
    note?: string;
  },
): Promise<{ scoreBefore: number; scoreAfter: number; restrictedUntil: string | null; pardoned: number }> {
  return tx(async (query) => {
    // a player who has never offended has no row, and a moderator can still be looking at one
    await query(`insert into account_standing (user_id) values ($1) on conflict (user_id) do nothing`, [userId]);
    const before = (
      await query<{ score: number; restricted_until: string | null }>(
        `select score, restricted_until from account_standing where user_id = $1 for update`,
        [userId],
      )
    )[0];
    const scoreBefore = Number(before?.score ?? STANDING_MAX);

    let pardoned: { id: string }[] = [];
    if (opts.pardonAll) {
      pardoned = await query<{ id: string }>(
        `update standing_events set voided_at = now(), voided_by = $2
          where user_id = $1 and voided_at is null returning id`,
        [userId, adminId],
      );
    } else if (opts.pardonIds?.length) {
      pardoned = await query<{ id: string }>(
        `update standing_events set voided_at = now(), voided_by = $3
          where user_id = $1 and id = any($2::bigint[]) and voided_at is null returning id`,
        [userId, opts.pardonIds, adminId],
      );
    }

    const scoreAfter =
      opts.score === undefined
        ? scoreBefore
        : Math.max(0, Math.min(STANDING_MAX, Math.round(opts.score)));
    const until =
      opts.lock === undefined
        ? before?.restricted_until ?? null
        : opts.lock === false
          ? null
          : new Date(Date.now() + Math.max(0, Math.round(opts.lock)) * 60_000).toISOString();

    await query(
      // `healed_at` moves with the score for the same reason an offence resets it: healing
      // credits elapsed time since it was last written, and banking idle days across an edit
      // then spending them a second later is exactly what that column exists to stop.
      `update account_standing
          set score = $2, restricted_until = $3, healed_at = now(), updated_at = now()
        where user_id = $1`,
      [userId, scoreAfter, until],
    );

    // ONE ledger row for the whole edit, carrying the SIGNED difference — negative points are
    // standing given back. Written even when the score did not move, because voiding offences
    // and lifting a lock are themselves the act, and a player whose queue reopened with
    // nothing in the ledger to explain it is back to the arbitrary system 0027 set out to
    // avoid.
    await query(
      `insert into standing_events
         (user_id, kind, points, score_after, cooldown_min, rating_charge, note, admin_id)
       values ($1, 'adjustment', $2, $3, 0, 0, $4, $5)`,
      [userId, scoreBefore - scoreAfter, scoreAfter, (opts.note ?? '').slice(0, 120) || null, adminId],
    );

    return { scoreBefore, scoreAfter, restrictedUntil: until, pardoned: pardoned.length };
  });
}

// -------------------------------------------------------- score reports ------

export interface ScoreReportRow {
  id: string;
  matchId: string | null;
  /**
   * The REPLAY of that match, which is the only thing that can settle a misscore claim.
   *
   * It has to be carried here rather than derived by the caller, and that is the whole bug
   * this column fixes: the queue passed `matchId` to `/api/replay/<id>` and every WATCH
   * button in the misscore queue 404'd. A match id and a replay id are different rows —
   * `matches.replay_id` is the join — and nothing about the two being uuids says so.
   */
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
  /** how many claims this reporter has EVER filed, and how many were rejected — the pattern
   * a moderator needs before deciding whether a claim is a mistake or a habit */
  reporterFiled: number;
  reporterRejected: number;
}

/**
 * File a misscore claim. False when this reporter already has one on this match — the unique
 * index, surfaced as a no-op, because a second look at the same result is the same claim.
 */
export async function submitScoreReport(r: {
  reporterId: string;
  matchId?: string | number | null;
  roomCode?: string;
  game?: Game;
  detail: string;
}): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `insert into score_reports (reporter_id, match_id, room_code, game, detail)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning id::text as id`,
    [r.reporterId, r.matchId ? String(r.matchId) : null, r.roomCode ?? '', g(r.game ?? 'decode'), r.detail],
  );
  return rows.length > 0;
}

/** the moderation queue: newest first, with the reporter's own history alongside each row. */
export async function listScoreReports(opts: { status?: string; limit?: number } = {}): Promise<ScoreReportRow[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const rows = await q<{
    id: string; match_id: string | null; replay_id: string | null; room_code: string;
    game: string; detail: string;
    status: string; smite: number; created_at: string; reporter_id: string;
    handle: string; username: string | null; filed: string; rejected: string;
  }>(
    // LEFT JOIN, because `score_reports.match_id` is nullable on purpose: a player looking at
    // a result that never finished writing is exactly the case worth hearing about, and it
    // must not drop out of the queue for having no match to point at.
    `select sr.id::text as id, sr.match_id::text as match_id, m.replay_id::text as replay_id,
            sr.room_code, sr.game, sr.detail,
            sr.status, sr.smite, sr.created_at, sr.reporter_id, p.handle, p.username,
            (select count(*) from score_reports x where x.reporter_id = sr.reporter_id) as filed,
            (select count(*) from score_reports x
              where x.reporter_id = sr.reporter_id and x.status = 'rejected') as rejected
       from score_reports sr
       join profiles p on p.user_id = sr.reporter_id
       left join matches m on m.id = sr.match_id
      where ($1::text is null or sr.status = $1::text)
      order by sr.created_at desc
      limit $2`,
    [opts.status ?? null, limit],
  );
  return rows.map((x) => ({
    id: x.id,
    matchId: x.match_id,
    replayId: x.replay_id,
    roomCode: x.room_code,
    game: x.game,
    detail: x.detail,
    status: x.status,
    smite: Number(x.smite ?? 0),
    createdAt: x.created_at,
    reporterId: x.reporter_id,
    reporterHandle: x.handle,
    reporterUsername: x.username,
    reporterFiled: Number(x.filed ?? 0),
    reporterRejected: Number(x.rejected ?? 0),
  }));
}

/**
 * Resolve one claim: `upheld` or `rejected`, and record the smite that went with it.
 *
 * The STANDING charge itself is not written here. It goes through `writeStandingEvent` like
 * every other offence, so a smite appears in the same ledger the player already reads and is
 * subject to the same tier and cooldown machinery — a punishment invented in its own table
 * would be one the player is never shown and no other code path knows about.
 *
 * Returns the reporter's id so the caller can charge them, and null if the row is already
 * resolved (two moderators, one queue).
 */
export async function resolveScoreReport(
  id: string,
  status: 'upheld' | 'rejected',
  adminId: string,
  smite = 0,
): Promise<{ reporterId: string; roomCode: string; game: string } | null> {
  const rows = await q<{ reporter_id: string; room_code: string; game: string }>(
    `update score_reports
        set status = $2, reviewed_by = $3, reviewed_at = now(), smite = $4
      where id = $1::bigint and status = 'open'
      returning reporter_id, room_code, game`,
    [id, status, adminId, Math.max(0, Math.floor(smite))],
  );
  if (!rows.length) return null;
  return { reporterId: rows[0].reporter_id, roomCode: rows[0].room_code, game: rows[0].game };
}

// ------------------------------------------------- match score corrections ---

export interface MatchScoreRow {
  matchId: string;
  replayId: string | null;
  game: string;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  /** the alliance totals as they stand. Every participant on an alliance carries that
   *  alliance's total (see `persistVersusMatch`), so the pair below IS the stored result. */
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
  /** every correction ever applied to this match, newest first */
  corrections: MatchScoreCorrectionRow[];
}

export interface MatchScoreCorrectionRow {
  id: string;
  adminId: string;
  redBefore: number;
  blueBefore: number;
  redAfter: number;
  blueAfter: number;
  note: string | null;
  at: string;
}

/** everything the score editor needs about one match: who played, what it says now, and what
 *  has already been done to it. Null when the id is not a match. */
export async function matchScoreDetail(matchId: string): Promise<MatchScoreRow | null> {
  const head = await q<{
    id: string; replay_id: string | null; game: string; mode: string;
    ranked: boolean | null; created_at: string;
  }>(
    `select m.id::text as id, m.replay_id::text as replay_id, m.game, m.mode, m.ranked, m.created_at
       from matches m where m.id = $1::uuid`,
    [matchId],
  );
  const m = head[0];
  if (!m) return null;
  const parts = await q<{
    user_id: string; handle: string; username: string | null; alliance: 'red' | 'blue';
    drivetrain: string; score: number; won: boolean | null;
    rating_before: number | null; rating_after: number | null;
  }>(
    `select mp.user_id, p.handle, p.username, mp.alliance, mp.drivetrain, mp.score, mp.won,
            mp.rating_before, mp.rating_after
       from match_participants mp
       join profiles p on p.user_id = mp.user_id
      where mp.match_id = $1::uuid
      order by mp.alliance, p.handle`,
    [matchId],
  );
  const corrections = await listScoreCorrections(matchId);
  const sideOf = (a: 'red' | 'blue'): number => parts.find((x) => x.alliance === a)?.score ?? 0;
  return {
    matchId: m.id,
    replayId: m.replay_id,
    game: m.game,
    mode: m.mode,
    ranked: m.ranked,
    createdAt: m.created_at,
    red: sideOf('red'),
    blue: sideOf('blue'),
    participants: parts.map((x) => ({
      userId: x.user_id,
      handle: x.handle,
      username: x.username,
      alliance: x.alliance,
      drivetrain: x.drivetrain,
      score: Number(x.score),
      won: x.won,
      ratingBefore: x.rating_before === null ? null : Number(x.rating_before),
      ratingAfter: x.rating_after === null ? null : Number(x.rating_after),
    })),
    corrections,
  };
}

export async function listScoreCorrections(matchId: string): Promise<MatchScoreCorrectionRow[]> {
  const rows = await q<{
    id: string; admin_id: string; red_before: number; blue_before: number;
    red_after: number; blue_after: number; note: string | null; at: string;
  }>(
    `select id::text as id, admin_id, red_before, blue_before, red_after, blue_after, note, at
       from match_score_corrections where match_id = $1::uuid order by at desc`,
    [matchId],
  );
  return rows.map((r) => ({
    id: r.id,
    adminId: r.admin_id,
    redBefore: Number(r.red_before),
    blueBefore: Number(r.blue_before),
    redAfter: Number(r.red_after),
    blueAfter: Number(r.blue_after),
    note: r.note,
    at: r.at,
  }));
}

/**
 * Correct a finished match's score.
 *
 * WHAT MOVES: every participant's `score` (to their alliance's new total) and their `won`
 * flag, which is re-derived rather than passed in — a correction that left a player recorded
 * as the winner of a match they are now shown losing would be a worse record than the wrong
 * number it replaced. A TIE sets `won` false on both sides, which is what the sim does too.
 *
 * WHAT DOES NOT MOVE: the RATING. Glicko-2 is sequential — every match since this one was
 * rated against the numbers it produced — so re-rating one match in the middle means
 * re-rating every match after it for everyone involved, and a moderation panel is not where
 * that decision belongs. `rating_before`/`rating_after` therefore stay exactly as they were
 * and the console says so out loud.
 *
 * Returns the before/after pair, or null when the id names no match.
 */
export async function correctMatchScore(
  matchId: string,
  next: { red: number; blue: number },
  adminId: string,
  note?: string,
): Promise<{ redBefore: number; blueBefore: number; redAfter: number; blueAfter: number } | null> {
  const red = Math.max(0, Math.round(next.red));
  const blue = Math.max(0, Math.round(next.blue));
  return tx(async (query) => {
    const rows = await query<{ alliance: 'red' | 'blue'; score: number }>(
      `select mp.alliance, mp.score from match_participants mp
         join matches m on m.id = mp.match_id
        where mp.match_id = $1::uuid for update of mp`,
      [matchId],
    );
    if (!rows.length) return null;
    const redBefore = rows.find((r) => r.alliance === 'red')?.score ?? 0;
    const blueBefore = rows.find((r) => r.alliance === 'blue')?.score ?? 0;

    await query(
      `update match_participants
          set score = case when alliance = 'red' then $2::int else $3::int end,
              won   = case when alliance = 'red' then $2::int > $3::int else $3::int > $2::int end
        where match_id = $1::uuid`,
      [matchId, red, blue],
    );
    await query(
      `insert into match_score_corrections
         (match_id, admin_id, red_before, blue_before, red_after, blue_after, note)
       values ($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [matchId, adminId, redBefore, blueBefore, red, blue, (note ?? '').slice(0, 300) || null],
    );
    return { redBefore: Number(redBefore), blueBefore: Number(blueBefore), redAfter: red, blueAfter: blue };
  });
}

// ------------------------------------------------------- player reports ------

/** File a report. Returns false when the same reporter has already filed this category
 *  against this player from this room — the unique index, surfaced as a no-op rather than
 *  an error, because a double-tap on the button is not a failure worth showing anyone. */
export async function submitReport(r: {
  reportedId: string;
  reporterId: string;
  reason: string;
  detail?: string | null;
  roomCode?: string;
  game?: Game;
}): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `insert into player_reports (reported_id, reporter_id, reason, detail, room_code, game)
     values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing
     returning id`,
    [r.reportedId, r.reporterId, r.reason, r.detail?.slice(0, 300) || null, r.roomCode ?? '', g(r.game)],
  );
  return rows.length > 0;
}

/** How many DISTINCT people have reported this player out of one room. The standing nudge
 *  is priced per reporter (and capped): one person filing three categories is one opinion,
 *  three people filing one each is three. */
export async function distinctReporters(reportedId: string, roomCode: string): Promise<number> {
  const rows = await q<{ n: number }>(
    `select count(distinct reporter_id)::int as n from player_reports
      where reported_id = $1 and room_code = $2`,
    [reportedId, roomCode],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The moderation QUEUE: one row per reported player, most recently reported first.
 *
 * Aggregated in SQL rather than by fetching every report and grouping in JS — the panel
 * wants counts and a recency ordering, and a moderator on a busy day should not be paging
 * thousands of rows to see twelve names. `reporters` is a DISTINCT count on purpose: four
 * reports from four people and four from one are completely different signals, and the
 * panel shows both numbers so a moderator can tell a pattern from a grudge.
 */
export async function listReportedUsers(limit = 60): Promise<ReportedUserRow[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = await q<{
    reported_id: string;
    handle: string;
    username: string | null;
    total: number;
    open: number;
    reporters: number;
    latest: string;
    reasons: { reason: string; n: number }[] | null;
  }>(
    `select r.reported_id,
            p.handle, p.username,
            count(*)::int as total,
            count(*) filter (where r.status = 'open')::int as open,
            count(distinct r.reporter_id)::int as reporters,
            max(r.created_at) as latest,
            (select json_agg(x) from (
               select reason, count(*)::int as n
                 from player_reports r2
                where r2.reported_id = r.reported_id
                group by reason
                order by n desc
             ) x) as reasons
       from player_reports r
       join profiles p on p.user_id = r.reported_id
      group by r.reported_id, p.handle, p.username
      order by max(r.created_at) desc
      limit $1`,
    [n],
  );
  return rows.map((x) => ({
    userId: x.reported_id,
    handle: x.handle,
    username: x.username,
    total: Number(x.total),
    open: Number(x.open),
    reporters: Number(x.reporters),
    latest: x.latest,
    reasons: (x.reasons ?? []).map((r) => ({ reason: r.reason, n: Number(r.n) })),
  }));
}

export interface ReportedUserRow {
  userId: string;
  handle: string;
  username: string | null;
  total: number;
  open: number;
  reporters: number;
  latest: string;
  reasons: { reason: string; n: number }[];
}

export interface ReportDetailRow {
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

/** every report filed against one player, newest first — the drill-down */
export async function listReportsFor(userId: string, limit = 100): Promise<ReportDetailRow[]> {
  const rows = await q<{
    id: string; reason: string; detail: string | null; room_code: string; game: string;
    status: string; created_at: string; handle: string; username: string | null;
  }>(
    `select r.id::text as id, r.reason, r.detail, r.room_code, r.game, r.status,
            r.created_at, p.handle, p.username
       from player_reports r
       join profiles p on p.user_id = r.reporter_id
      where r.reported_id = $1
      order by r.created_at desc
      limit $2`,
    [userId, Math.min(300, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((x) => ({
    id: x.id,
    reason: x.reason,
    detail: x.detail,
    roomCode: x.room_code,
    game: x.game,
    status: x.status,
    createdAt: x.created_at,
    reporterHandle: x.handle,
    reporterUsername: x.username,
  }));
}

/**
 * Every report this player has FILED — the other direction, and the one the console could
 * not show.
 *
 * ⚠️ A COUNT DOES NOT ANSWER THE QUESTION IT RAISES. The account panel printed "14 filed · 9
 * rejected" and stopped there, which tells a moderator that something is wrong and nothing
 * about what: nine rejections spread over a year of honest confusion and nine filed at the
 * same opponent in one evening are the same two numbers and completely different decisions.
 * The rows are already in `player_reports` under `reporter_id`, indexed for the queue, so
 * this is the same shape as `listReportsFor` read from the other column — `subject` naming
 * the REPORTED player, since that is the useful name on a row whose filer is already known.
 */
export interface ReportFiledRow {
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

export async function listReportsBy(userId: string, limit = 50): Promise<ReportFiledRow[]> {
  const rows = await q<{
    id: string; reason: string; detail: string | null; room_code: string; game: string;
    status: string; created_at: string; reported_id: string; handle: string | null; username: string | null;
  }>(
    // LEFT JOIN, unlike `listReportsFor`'s inner one. ⚠️ It does NOT rescue a row from a
    // deleted subject — `player_reports.reported_id` cascades (0026), so that row is already
    // gone and the "filed" count a moderator reads is a FLOOR rather than a total. What the
    // left join buys is that a subject with no `profiles` row (the lazily-created case
    // `profileNames` exists for) still appears, instead of silently thinning the history
    // somebody is being judged on. `npm run dbtest` pins both halves.
    `select r.id::text as id, r.reason, r.detail, r.room_code, r.game, r.status,
            r.created_at, r.reported_id, p.handle, p.username
       from player_reports r
       left join profiles p on p.user_id = r.reported_id
      where r.reporter_id = $1
      order by r.created_at desc
      limit $2`,
    [userId, Math.min(200, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((x) => ({
    id: x.id,
    reason: x.reason,
    detail: x.detail,
    roomCode: x.room_code,
    game: x.game,
    status: x.status,
    createdAt: x.created_at,
    subjectId: x.reported_id,
    subjectHandle: x.handle,
    subjectUsername: x.username,
  }));
}

/** triage: mark every open report against a player reviewed or dismissed. Per-user rather
 *  than per-report because that is how the queue is actually worked — a moderator judges a
 *  PLAYER after watching their matches, not each complaint in isolation. */
export async function setReportsStatus(
  userId: string,
  status: 'reviewed' | 'dismissed',
  moderatorId: string,
): Promise<number> {
  const rows = await q<{ id: string }>(
    `update player_reports
        set status = $2, reviewed_by = $3, reviewed_at = now()
      where reported_id = $1 and status = 'open'
      returning id`,
    [userId, status, moderatorId],
  );
  return rows.length;
}

/**
 * A reported player's recent matches WITH their replay ids — the whole point of the
 * moderation drill-down. A cheating or throwing report is unjudgeable from text; the
 * moderator has to watch the match, and making them go and find it elsewhere is how a
 * report queue stops being worked.
 */
export async function userRecentMatches(userId: string, limit = 15): Promise<{
  matchId: string;
  replayId: string | null;
  game: string;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  score: number;
  won: boolean | null;
}[]> {
  const rows = await q<{
    id: string; replay_id: string | null; game: string; mode: string;
    ranked: boolean | null; created_at: string; score: number; won: boolean | null;
  }>(
    `select m.id::text as id, m.replay_id::text as replay_id, m.game, m.mode, m.ranked,
            m.created_at, mp.score, mp.won
       from match_participants mp
       join matches m on m.id = mp.match_id
      where mp.user_id = $1
      order by m.created_at desc
      limit $2`,
    [userId, Math.min(50, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((x) => ({
    matchId: x.id,
    replayId: x.replay_id,
    game: x.game,
    mode: x.mode,
    ranked: x.ranked,
    createdAt: x.created_at,
    score: x.score,
    won: x.won,
  }));
}

/** one row of a ranked board. Same name-plus-badge shape as `BoardRow` — the two
 *  boards sit behind one segmented control and render through the same cell. */
export interface EloBoardRow {
  userId: string;
  handle: string;
  username: string | null;
  rating: number;
  games: number;
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
}

/** The public leaderboard for an ACT's board — PLACED players only (games >=
 * PLACEMENT_GAMES). Players still in placements are intentionally omitted;
 * `eloUserStanding` reports the viewer's own standing separately. */
export async function eloLeaderboard(opts: {
  mode: '1v1' | '2v2';
  act: number;
  limit?: number;
  game?: Game;
}): Promise<EloBoardRow[]> {
  return q<EloBoardRow>(
    `select e.user_id as "userId", p.handle, p.username, e.rating, e.games,
            ${badgeCols('p.')}
     from elo_ratings e join profiles p on p.user_id = e.user_id
     where e.act = $1 and e.mode = $2 and e.game = $5 and e.games >= $4
     -- user_id LAST: a tie on rating AND games is decided the same way on every read, so an
     -- award computed off this board (rankedActGrants) names the same person the board does
     order by e.rating desc, e.games desc, e.user_id
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
}): Promise<EloBoardRow[]> {
  return q<EloBoardRow>(
    `select h.user_id as "userId", p.handle, p.username, h.rating, h.games,
            ${badgeCols('p.')}
     from elo_history h join profiles p on p.user_id = h.user_id
     where h.balance_version = $1 and h.mode = $2 and h.game = $5 and h.games >= $4
     order by h.rating desc, h.games desc, h.user_id
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

/** where a game was played (migration 0050). Server rooms report the first four at match end;
 * a client that was online reports the last two, which run off the cloud. */
export type PlaySource = 'record' | 'ranked' | 'custom' | 'discord' | 'practice' | 'lan';
export type PlayMode = 'solo' | 'duo' | '1v1' | '2v2';
export const PLAY_SOURCES: readonly PlaySource[] = ['record', 'ranked', 'custom', 'discord', 'practice', 'lan'];
export const PLAY_MODES: readonly PlayMode[] = ['solo', 'duo', '1v1', '2v2'];

/** Count one game played. One upsert on today's (UTC) row; no identity is stored. */
export async function countPlay(game: Game | undefined, source: PlaySource, mode: PlayMode): Promise<void> {
  await q(
    `insert into play_counts (day, game, source, mode, n)
     values ((now() at time zone 'utc')::date, $1, $2, $3, 1)
     on conflict (day, game, source, mode) do update set n = play_counts.n + 1`,
    [g(game), source, mode],
  );
}

/**
 * The homepage's categories, folded from the raw split:
 * solo = record solo + practice · duo = record duo · 1v1 / 2v2 = ranked ·
 * custom = custom rooms + Discord rooms + LAN, any format.
 */
export function playCategory(source: PlaySource, mode: PlayMode): keyof GlobalStats['byCategory'] | null {
  switch (source) {
    case 'practice':
      return 'solo';
    case 'record':
      return mode === 'duo' ? 'duo' : 'solo';
    case 'ranked':
      return mode === '2v2' ? '2v2' : mode === '1v1' ? '1v1' : null;
    case 'custom':
    case 'discord':
    case 'lan':
      return 'custom';
  }
}

export interface GlobalStats {
  users: number;
  /** total games played — COMBINED across every game and source (the homepage headline) */
  games: number;
  /** the homepage's categories; see `playCategory` for what each one folds in */
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number; custom: number };
  /** games played PER GAME, every source */
  byGame: Record<Game, number>;
  /** the raw split the categories are folded from: per game × source × mode */
  detail: { game: Game; source: PlaySource; mode: PlayMode; n: number }[];
}

/** site-wide totals for the homepage: registered players + games played, from the
 * `play_counts` counters (migration 0050). */
/**
 * MEMOIZED, because this is a PUBLIC, UNAUTHENTICATED endpoint (`/api/stats`, api.ts) that
 * every homepage load hits. `play_counts` grows by at most games × sources × modes rows a day,
 * so the sum is cheap, but `count(*)` over `profiles` still reads every entry, and N
 * concurrent visitors should not be N scans of it. A number rendered as "12,431 games played"
 * does not need to be current to the second.
 *
 * Same shape as `actCache` above and `userRoomCache` below: a module-level `{at, val}` with
 * a millisecond constant. 60s rather than something longer because this is what the
 * homepage's liveness reads as.
 */
const STATS_TTL_MS = 60_000;
let statsCache: { at: number; val: GlobalStats } | null = null;

/** drop the memo — for tests, and for an admin who wants the real number now */
export function clearStatsCache(): void {
  statsCache = null;
}

export async function getGlobalStats(now = Date.now()): Promise<GlobalStats> {
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.val;
  const [users, rows] = await Promise.all([
    q<{ n: string }>(`select count(*) as n from profiles`),
    q<{ game: Game; source: PlaySource; mode: PlayMode; n: string }>(
      `select game, source, mode, sum(n) as n from play_counts group by game, source, mode order by 1, 2, 3`,
    ),
  ]);
  const byCategory: GlobalStats['byCategory'] = { solo: 0, duo: 0, '1v1': 0, '2v2': 0, custom: 0 };
  // seeded from GAME_IDS so a new game reports 0 rather than being absent from the map
  const byGame = Object.fromEntries(GAME_IDS.map((g) => [g, 0])) as Record<Game, number>;
  const detail: GlobalStats['detail'] = [];
  let games = 0;
  for (const r of rows) {
    const n = Number(r.n);
    detail.push({ game: r.game, source: r.source, mode: r.mode, n });
    games += n;
    const cat = playCategory(r.source, r.mode);
    if (cat) byCategory[cat] += n;
    if (r.game in byGame) byGame[r.game] += n;
  }
  const val: GlobalStats = { users: Number(users[0]?.n ?? 0), games, byCategory, byGame, detail };
  statsCache = { at: now, val };
  return val;
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
  /** active supporter membership — the profile header badge */
  supporter?: boolean;
  /** 'owner' | 'admin' — the staff badge, which replaces the supporter one */
  role?: StaffRole;
  season: number;
  elo: UserEloStat[];
  records: UserRecordStat[];
  match: { played: number; wins: number; losses: number };
  recent: UserMatchRow[];
  /**
   * LIFETIME playtime and games played — for THIS game, plus the combined total across
   * every game. Deliberately not season-scoped like everything above it: "how much have I
   * played" is a question about the account, not about the current act, and resetting it
   * every season would make the number meaningless the moment it got interesting.
   */
  activity?: { games: number; seconds: number; allGames: number; allSeconds: number };
  /**
   * EVERY SEASON AWARD THIS ACCOUNT HOLDS (0045, and the claimed grants since 0048).
   *
   * Deliberately NOT season-scoped like `elo` and `records` above: a trophy case is a
   * fact about the account, and filtering it to the season the page happens to be
   * showing would hide every award the moment a new season opened — which is the one
   * thing an award must never do. Same reasoning as `activity` directly above.
   */
  awards?: SeasonAward[];
  /** the EQUIPPED badges and their counters — the header beside the name (0048). */
  badges?: EquippedBadge[];
  /** EVERY badge this account holds and how many times — the trophy case (0048). Claimed
   *  grants only, like `awards`: a reward the player has not taken yet is not on show. */
  badgeCounts?: Record<string, number>;
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
  /**
   * THE CAREER PANEL'S RECORD HALF IS THE SAME BOARD, so it reads the same era.
   *
   * `recPb` and `recRank` below are "your best run" and "where it places" — the two figures
   * the Records page prints beside the board itself. Left unfiltered they would have shown a
   * BIOBUZZ player a 2D personal best that appears on no board and a rank over a population
   * the board does not contain. The value is PARAMETERISED (`$4` in both queries) — the SQL
   * fragment is chosen here, the era itself is bound.
   */
  const phys = await boardPhysics(gm, balanceVersion, current);
  const recPhys = phys ? 'and physics = $4' : '';
  const [profile, elo, recPb, recRank, match, recent] = await Promise.all([
    q<{ handle: string; username: string | null; supporter: boolean; role: string | null }>(
      `select handle, username, role, ${SUPPORTER_COL} from profiles where user_id = $1`,
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
       from records where user_id = $1 and balance_version = $2 and game = $3 ${recPhys}
       order by mode, score desc, created_at asc`,
      phys ? [userId, balanceVersion, gm, phys] : [userId, balanceVersion, gm],
    ),
    q<{ mode: 'solo' | 'duo'; rnk: string }>(
      // the era filter sits INSIDE `best`, for the reason `recordLeaderboard` documents:
      // one row per player, so filtering after it drops a player who has a 3D run
      `with best as (
         select user_id, mode, max(score) as score
         from records where balance_version = $1 and game = $3 ${recPhys} group by user_id, mode
       ), ranked as (
         select user_id, mode, rank() over (partition by mode order by score desc) as rnk
         from best
       )
       select mode, rnk from ranked where user_id = $2`,
      phys ? [balanceVersion, userId, gm, phys] : [balanceVersion, userId, gm],
    ),
    // RANKED only — the Career panel labels it "Ranked W–L", and a custom game can be
    // one-sided or against bots, which would hand out free wins
    q<{ played: string; wins: string }>(
      `select count(*) as played, count(*) filter (where mp.won) as wins
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2 and m.game = $3 and m.ranked`,
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
  const activity = await getActivity(userId);
  const mine = activity.byGame[gm] ?? { games: 0, seconds: 0 };

  return {
    userId,
    handle: profile[0]?.handle ?? null,
    supporter: !!profile[0]?.supporter,
    role: asRole(profile[0]?.role),
    username: profile[0]?.username ?? null,
    season: balanceVersion,
    elo: elos,
    records,
    match: { played, wins, losses: played - wins },
    recent,
    activity: {
      games: mine.games,
      seconds: mine.seconds,
      allGames: activity.total.games,
      allSeconds: activity.total.seconds,
    },
    awards: await trophyCase(userId),
    ...(await (async () => {
      const r = await q<{ equipped_badges: unknown }>(`select equipped_badges from profiles where user_id = $1`, [userId]);
      return { badges: asEquipped(r[0]?.equipped_badges) };
    })()),
    badgeCounts: await badgeCounts(userId),
  };
}

/**
 * THE TROPHY CASE: the retired `season_awards` rows and the claimed competitive grants, one
 * row per placement. A placement both hold (a record award 0045 minted that the award job
 * then paid again under the new criteria) is ONE row — the `awardKey` is the same, so is the
 * thing it names.
 */
async function trophyCase(userId: string): Promise<SeasonAward[]> {
  const [legacy, current] = await Promise.all([userAwards(userId), competitiveAwards(userId)]);
  const seen = new Set<string>();
  const out: SeasonAward[] = [];
  for (const a of [...current, ...legacy]) {
    const key = awardKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// ------------------------------------------------------- playtime + games ---

/**
 * Credit one finished match to every account that played it.
 *
 * ONE STATEMENT for the whole roster, not a query per player: this runs at match end
 * alongside the other writes, and a four-player match should not be four round-trips to add
 * four integers. `unnest` turns the id list into rows the upsert can join against.
 *
 * Seconds are ROUNDED here rather than stored as a float. The input is a tick count, the
 * output is read in hours, and a column that accumulates 0.7333-second fragments for years
 * is a column that will eventually be explained to somebody.
 */
export async function addActivity(
  userIds: string[],
  seconds: number,
  game?: Game,
): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  const secs = Math.max(0, Math.round(seconds));
  await q(
    `insert into user_activity (user_id, game, games, seconds)
     select id, $2, 1, $3 from unnest($1::text[]) as id
     on conflict (user_id, game) do update
       set games = user_activity.games + 1,
           seconds = user_activity.seconds + excluded.seconds,
           updated_at = now()`,
    [ids, g(game), secs],
  );
}

/** what this account has played, per game plus the combined total */
export async function getActivity(userId: string): Promise<{
  total: { games: number; seconds: number };
  byGame: Record<string, { games: number; seconds: number }>;
}> {
  const rows = await q<{ game: string; games: number; seconds: number }>(
    `select game, games, seconds from user_activity where user_id = $1`,
    [userId],
  );
  const byGame: Record<string, { games: number; seconds: number }> = {};
  let games = 0;
  let seconds = 0;
  for (const r of rows) {
    byGame[r.game] = { games: Number(r.games), seconds: Number(r.seconds) };
    games += Number(r.games);
    seconds += Number(r.seconds);
  }
  return { total: { games, seconds }, byGame };
}

// ------------------------------------------------------ PvP match history ---
export async function saveMatch(
  mode: '1v1' | '2v2',
  balanceVersion: number,
  replayId: string,
  ranked: boolean,
  game?: Game,
  /** which physics solve the authoritative loop ran (0039). Absent ⇒ '2d'. */
  physics?: string,
): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into matches (mode, balance_version, replay_id, ranked, game, physics) values ($1, $2, $3, $4, $5, $6) returning id`,
    [mode, balanceVersion, replayId, ranked, g(game), physics === '3d' ? '3d' : '2d'],
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

/**
 * Every participant of one match in ONE insert, the same `unnest` shape `addActivity` uses.
 *
 * The per-row version above stays: it is the readable one and nothing else calls it in a
 * loop. This exists because `persistVersusMatch` did, and four inserts issued one after
 * another at the end of every match is three round trips of pure latency on the path a
 * player is watching for their rating change.
 */
export async function addMatchParticipants(
  matchId: string,
  ps: readonly {
    userId: string;
    alliance: 'red' | 'blue';
    drivetrain: string;
    score: number;
    won: boolean;
    ratingBefore: number | null;
    ratingAfter: number | null;
  }[],
): Promise<void> {
  if (!ps.length) return;
  await q(
    `insert into match_participants
       (match_id, user_id, alliance, drivetrain, score, won, rating_before, rating_after)
     select $1, u, a, d, s, w, rb, ra
       from unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::bool[], $7::real[], $8::real[])
            as t(u, a, d, s, w, rb, ra)
     on conflict (match_id, user_id) do nothing`,
    [
      matchId,
      ps.map((p) => p.userId),
      ps.map((p) => p.alliance),
      ps.map((p) => p.drivetrain),
      ps.map((p) => p.score),
      ps.map((p) => p.won),
      ps.map((p) => p.ratingBefore),
      ps.map((p) => p.ratingAfter),
    ],
  );
}

// ---------------------------------------------------- unified match history ---
export interface MatchHistoryPlayer {
  userId: string;
  handle: string;
  username: string | null;
  alliance: 'red' | 'blue' | null; // null for record-run partners
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
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
    /** WHO IS READING — not who is being read. A versus row's `replayId` is nulled for a
     * viewer who may not watch it (migration 0038), so the Watch button is simply absent
     * rather than present and answering 403. Anonymous when omitted. */
    viewerId?: string | null;
    /** staff see every Watch button, because the report queue is how they reach a match */
    viewerIsStaff?: boolean;
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
  // the replay gate, per versus match: did EVERY participant opt in, and is the reader one
  // of them? (0038 — unanimity, because the log shows both alliances.)
  const publicByMatch = new Map<string, boolean>();
  const mineByMatch = new Set<string>();
  if (versusIds.length) {
    const parts = await q<{
      id: string;
      user_id: string;
      alliance: 'red' | 'blue';
      score: number;
      handle: string;
      username: string | null;
      role: string | null;
      supporter: boolean;
      replays_public: boolean;
    }>(
      // `replays_public` rides along on a profile row this query already joins, so the
      // replay gate costs nothing here — see `watchable` below.
      `select mp.match_id::text as id, mp.user_id, mp.alliance, mp.score, p.handle, p.username,
              coalesce(p.replays_public, false) as replays_public,
              ${badgeCols('p.')}
       from match_participants mp join profiles p on p.user_id = mp.user_id
       where mp.match_id = any($1::uuid[])`,
      [versusIds],
    );
    for (const p of parts) {
      publicByMatch.set(p.id, (publicByMatch.get(p.id) ?? true) && p.replays_public);
      if (p.user_id === opts.viewerId) mineByMatch.add(p.id);
      const list = byMatch.get(p.id) ?? [];
      list.push({
        userId: p.user_id,
        handle: p.handle,
        username: p.username,
        alliance: p.alliance,
        supporter: !!p.supporter,
        role: asRole(p.role),
      });
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
    const profs = await q<{
      user_id: string;
      handle: string;
      username: string | null;
      role: string | null;
      supporter: boolean;
    }>(
      `select user_id, handle, username, ${badgeCols('')} from profiles where user_id = any($1::text[])`,
      [[...need]],
    );
    const byUser = new Map(profs.map((p) => [p.user_id, p]));
    const mk = (uid: string): MatchHistoryPlayer => {
      const p = byUser.get(uid);
      return {
        userId: uid,
        handle: p?.handle ?? 'Player',
        username: p?.username ?? null,
        alliance: null,
        supporter: !!p?.supporter,
        role: asRole(p?.role),
      };
    };
    for (const r of recs) {
      const list = [mk(userId)];
      if (r.partner_id) list.push(mk(r.partner_id));
      recPlayers.set(r.id, list);
    }
  }

  /** may THIS reader open this row's replay? This half only decides whether the button is
   * DRAWN; `replayAccess` is what the fetch enforces — so the release test is literally the
   * same function, called with this page's already-joined numbers. A record run's replay
   * stays public (it is the leaderboard's proof); a versus one needs the reader to have
   * played in it, or the whole roster to have opted in. */
  const watchable = (r: { kind: string; id: string; mode: string }): boolean =>
    r.kind !== 'versus' ||
    !!opts.viewerIsStaff ||
    mineByMatch.has(r.id) ||
    versusReleased(r.mode, byMatch.get(r.id)?.length ?? 0, publicByMatch.get(r.id) ?? false);

  return {
    rows: rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      mode: r.mode,
      ranked: r.ranked,
      drivetrain: r.drivetrain,
      createdAt: r.created_at,
      replayId: watchable(r) ? r.replay_id : null,
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

/** one finished game in the operator's "Recent games" list */
export interface RecentMatchRow {
  kind: 'versus' | 'record';
  id: string;
  game: string;
  /** '1v1' | '2v2' (versus) or 'solo' | 'duo' (record) */
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  replayId: string | null;
  balanceVersion: number;
  /** final alliance totals (versus) — both null for a record run */
  redScore: number | null;
  blueScore: number | null;
  /** the record run's score (record only) */
  score: number | null;
  players: { userId: string; handle: string; alliance: 'red' | 'blue' | null }[];
}

/**
 * The most recently FINISHED games across the whole service, for the admin panel.
 *
 * The counterpart to the live list: an operator investigating a report ("that
 * match five minutes ago") needs the game after it has stopped being live, and a
 * finished match cannot be spectated — only replayed. So this carries `replayId`,
 * which is what the row's button opens.
 *
 * Deliberately NOT season- or version-scoped. Every other history query filters by
 * `balance_version` because it feeds a leaderboard, where mixing balance versions
 * would compare incomparable runs; this one answers "what just happened on the
 * server", and the answer must not disappear the moment a season rolls over. The
 * version is reported per row instead.
 */
export async function recentMatches(limit = 40, game?: Game): Promise<RecentMatchRow[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit)));
  const gameFilter = game ? `where game = $2` : '';
  const params: unknown[] = game ? [n, g(game)] : [n];
  const rows = await q<{
    kind: 'versus' | 'record';
    id: string;
    game: string;
    mode: string;
    ranked: boolean | null;
    created_at: string;
    replay_id: string | null;
    balance_version: number;
    score: number | null;
  }>(
    `with feed as (
       select 'versus' as kind, m.id::text as id, m.game as game, m.mode as mode,
              m.ranked as ranked, m.created_at as created_at, m.replay_id::text as replay_id,
              m.balance_version as balance_version, null::int as score
         from matches m
       union all
       select 'record', r.id::text, r.game, r.mode, null::boolean, r.created_at,
              r.replay_id::text, r.balance_version, r.score
         from records r
     )
     select * from feed ${gameFilter} order by created_at desc limit $1`,
    params,
  );
  if (rows.length === 0) return [];

  // one fan-out for the versus rosters; record runs carry only their owner, which
  // the feed above does not select (the union has to stay column-compatible), so
  // they are fetched in the same round of work rather than per row.
  const versusIds = rows.filter((r) => r.kind === 'versus').map((r) => r.id);
  const recordIds = rows.filter((r) => r.kind === 'record').map((r) => r.id);
  const [parts, recs] = await Promise.all([
    versusIds.length
      ? q<{ match_id: string; user_id: string; handle: string; alliance: 'red' | 'blue'; score: number }>(
          `select mp.match_id::text as match_id, mp.user_id, p.handle, mp.alliance, mp.score
             from match_participants mp join profiles p on p.user_id = mp.user_id
            where mp.match_id = any($1::uuid[])`,
          [versusIds],
        )
      : Promise.resolve([]),
    recordIds.length
      ? q<{ id: string; user_id: string; handle: string }>(
          `select r.id::text as id, r.user_id, p.handle
             from records r join profiles p on p.user_id = r.user_id
            where r.id = any($1::uuid[])`,
          [recordIds],
        )
      : Promise.resolve([]),
  ]);

  const roster = new Map<string, RecentMatchRow['players']>();
  const scores = new Map<string, { red: number | null; blue: number | null }>();
  for (const p of parts) {
    const list = roster.get(p.match_id) ?? [];
    list.push({ userId: p.user_id, handle: p.handle, alliance: p.alliance });
    roster.set(p.match_id, list);
    // every participant on an alliance stores that alliance's TOTAL, so either
    // one gives the side's score (see MatchHistoryEntry)
    const s = scores.get(p.match_id) ?? { red: null, blue: null };
    s[p.alliance] = p.score;
    scores.set(p.match_id, s);
  }
  for (const r of recs) {
    roster.set(r.id, [{ userId: r.user_id, handle: r.handle, alliance: null }]);
  }

  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    game: r.game,
    mode: r.mode,
    ranked: r.ranked,
    createdAt: r.created_at,
    replayId: r.replay_id,
    balanceVersion: r.balance_version,
    redScore: r.kind === 'versus' ? scores.get(r.id)?.red ?? null : null,
    blueScore: r.kind === 'versus' ? scores.get(r.id)?.blue ?? null : null,
    score: r.kind === 'record' ? r.score : null,
    players: roster.get(r.id) ?? [],
  }));
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
    // ...and the physics, stashed the same way (0039 added no column for it: a staged row
    // lives for seconds, so a jsonb field that older rows simply lack is the whole migration)
    physics: r.roster[0]?.physics,
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

// -------------------------------------------------------- presence ----------
// Cross-machine presence: each region's machine only knows its OWN sockets, so a
// shared table + aggregate read gives a GLOBAL count (see 0015_presence.sql).

export interface GlobalPresence {
  online: number;
  signedIn: number;
  /** every game combined — the shape older clients read. Do not remove. */
  queues: { '1v1': number; '2v2': number };
  /**
   * Depth split BY GAME, which is the only version a player can act on: pairing is
   * bucketed by game, so a DECODE player can never be matched with a Chain Reaction
   * queuer and must not be told one is waiting for them. Keyed by game id.
   */
  gameQueues: Record<string, { '1v1': number; '2v2': number }>;
}

/** merge per-game queue depths from one machine into an accumulator */
function addGameQueues(
  into: Record<string, { '1v1': number; '2v2': number }>,
  from: unknown,
): void {
  if (!from || typeof from !== 'object') return;
  for (const [game, q] of Object.entries(from as Record<string, unknown>)) {
    if (!q || typeof q !== 'object') continue;
    const one = q as Partial<Record<'1v1' | '2v2', unknown>>;
    into[game] ??= { '1v1': 0, '2v2': 0 };
    for (const m of ['1v1', '2v2'] as const) {
      const n = one[m];
      if (typeof n === 'number' && Number.isFinite(n)) into[game][m] += n;
    }
  }
}

/**
 * What ONE signed-in account is doing, as the server already knows it.
 *
 * Everything here is state the match server must hold anyway to run a game — it is
 * republished for operators, not gathered for them. And it stops short of a
 * behavioural record on purpose: `act` is the same coarse bucket the player's own
 * friends list already shows their friends, and there is deliberately no field for
 * which screen or menu they are looking at.
 */
export interface PresencePlayer {
  userId: string;
  /** how many SOCKETS this account holds on this machine (two tabs, or a lobby
   *  socket plus a match socket). Without it the tiles cannot be made to add up:
   *  "online" counts sockets and "signed in" counts people, so one player with two
   *  tabs makes the two numbers disagree with no visible reason. */
  sessions?: number;
  /** coarse activity — the friends-list vocabulary, nothing finer */
  act: 'menu' | 'lobby' | 'match';
  /** the room they are in, when they are in one (already public via /api/live) */
  room?: string;
  /** ranked queue bucket, when queued — the operational fact behind "why is
   *  matchmaking not pairing?", and the one queue abuse is visible in */
  queue?: '1v1' | '2v2';
  /** whole seconds queued so far (a stuck queue is the thing worth seeing) */
  queuedS?: number;
  /** which GAME they are queued for — kept apart from `game` because the two can
   *  differ (queued for Chain Reaction while in a DECODE practice room), and an
   *  operator shown only one of them is being told a half-truth */
  queueGame?: string;
  game?: string;
}

/**
 * ONE anonymous (not signed in) session, for the operator view.
 *
 * Listed individually at the operator's request — earlier this was counts only. The
 * identifier is the SERVER'S OWN CONNECTION ID: a per-socket string this process
 * already generates to route messages. It is not derived from anything about the
 * person, it is not an IP or a fingerprint, it is not stored anywhere else, and it
 * ceases to exist when the socket closes — reconnecting produces an unrelated id.
 * So a guest can be told apart from another guest *right now*, which is what an
 * operator needs to see "who is idle vs in a lobby", without becoming something
 * that can follow anyone between sessions.
 */
export interface PresenceGuest {
  /** ephemeral per-connection id; dies with the socket */
  id: string;
  act: 'menu' | 'lobby' | 'match';
  room?: string;
  game?: string;
}

/** rolled-up guest counts, derived from the rows (kept for the summary tiles) */
export interface PresenceAnon {
  total: number;
  inMatch: number;
  inLobby: number;
  idle: number;
}

/** heartbeat THIS machine's live counts (upsert keyed by machine id). SNAPSHOT
 * only: every field is replaced by the next beat, so nothing accumulates here. */
export async function upsertPresence(
  machine: string,
  region: string,
  online: number,
  authedUserIds: string[],
  q1v1: number,
  q2v2: number,
  rooms: unknown[] = [],
  players: PresencePlayer[] = [],
  anon: PresenceAnon | null = null,
  gameQueues: Record<string, { '1v1': number; '2v2': number }> = {},
  guests: PresenceGuest[] = [],
): Promise<void> {
  await q(
    `insert into presence (machine, region, online, authed, q1v1, q2v2, rooms, players, anon, game_queues, guests, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, now())
     on conflict (machine) do update
       set region = $2, online = $3, authed = $4::jsonb, q1v1 = $5, q2v2 = $6,
           rooms = $7::jsonb, players = $8::jsonb, anon = $9::jsonb,
           game_queues = $10::jsonb, guests = $11::jsonb, updated_at = now()`,
    [
      machine, region, online, JSON.stringify(authedUserIds), q1v1, q2v2,
      JSON.stringify(rooms), JSON.stringify(players), JSON.stringify(anon ?? {}),
      JSON.stringify(gameQueues), JSON.stringify(guests),
    ],
  );
}

/** where one player is playing right now, resolved from the heartbeat */
export interface UserLiveRoom {
  /** the room code to spectate */
  room: string;
  /** the Fly region hosting it — a custom room's code has no region prefix, so a
   *  spectate socket opened without this lands on the wrong machine */
  region: string;
  ranked: boolean;
}

const USER_ROOM_TTL_MS = 3_000;
let userRoomCache: { at: number; val: Map<string, UserLiveRoom> } | null = null;

/**
 * Which live match each signed-in player is IN, keyed by user id — the lookup
 * behind "watch your friend's game".
 *
 * Built from the presence heartbeat, so it is the SERVER's own observation of
 * where somebody is, not a claim the client makes about itself. Two columns of
 * the same rows are used together: `players` says which room each account holds a
 * socket in, and `rooms` says which of those rooms has a match actually running.
 * Both are needed — a room whose match has ended still holds its sockets for a
 * while, and offering that as watchable would send the watcher to a dead world.
 *
 * INVISIBLE players never reach this: a friend's row only asks for a room when
 * `listFriends` already resolved them as online, which invisibility rules out.
 *
 * Cached for a few seconds because every friends poll on the service asks for it
 * and the answer is the same for all of them.
 */
export async function liveRoomsByUser(freshSeconds = 15): Promise<Map<string, UserLiveRoom>> {
  const now = Date.now();
  if (userRoomCache && now - userRoomCache.at < USER_ROOM_TTL_MS) return userRoomCache.val;
  const rows = await q<{ region: string; rooms: unknown[] | null; players: PresencePlayer[] | null }>(
    `select region, rooms, players from presence
      where updated_at > now() - $1::interval and jsonb_array_length(players) > 0`,
    [`${Math.max(1, Math.floor(freshSeconds))} seconds`],
  );
  const out = new Map<string, UserLiveRoom>();
  for (const r of rows) {
    const live = new Map<string, { ranked: boolean; region?: string }>();
    for (const s of Array.isArray(r.rooms) ? r.rooms : []) {
      const lr = s as { room?: string; ranked?: boolean; region?: string };
      if (lr?.room) live.set(lr.room.toLowerCase(), { ranked: lr.ranked === true, region: lr.region });
    }
    for (const p of Array.isArray(r.players) ? r.players : []) {
      if (p.act !== 'match' || !p.room) continue;
      const hit = live.get(p.room.toLowerCase());
      if (!hit) continue; // holding a socket in a room whose match is over
      out.set(p.userId, { room: p.room, region: hit.region ?? r.region, ranked: hit.ranked });
    }
  }
  userRoomCache = { at: now, val: out };
  return out;
}

/** every live room across EVERY region with a fresh heartbeat. This is what makes
 *  "Watch Live" show the whole service instead of whichever region anycast picked. */
export async function globalLiveRooms(freshSeconds = 15): Promise<unknown[]> {
  const rows = await q<{ rooms: unknown[] }>(
    `select rooms from presence
      where updated_at > now() - $1::interval and jsonb_array_length(rooms) > 0
      order by region`,
    [`${Math.max(1, Math.floor(freshSeconds))} seconds`],
  );
  return rows.flatMap((r) => (Array.isArray(r.rooms) ? r.rooms : []));
}

/** the operator view: per-machine rows with their players + anonymous buckets.
 *  Handles are resolved HERE rather than stored on the heartbeat, so the snapshot
 *  itself carries ids only and no names are duplicated into it. */
export interface AdminPresenceRow {
  machine: string;
  region: string;
  online: number;
  updatedAt: string;
  players: (PresencePlayer & {
    handle: string | null;
    username: string | null;
    role: StaffRole | null;
    /** a `profiles` row exists for this id — see `profileNames` for why the two
     *  cases have to be told apart rather than both rendering as "no profile" */
    known: boolean;
  })[];
  guests: PresenceGuest[];
  anon: PresenceAnon;
}
export async function adminPresence(freshSeconds = 20): Promise<AdminPresenceRow[]> {
  const rows = await q<{
    machine: string; region: string; online: number; updated_at: string;
    players: PresencePlayer[] | null; anon: PresenceAnon | null; guests: PresenceGuest[] | null;
  }>(
    `select machine, region, online, updated_at, players, anon, guests from presence
      where updated_at > now() - $1::interval order by region`,
    [`${Math.max(1, Math.floor(freshSeconds))} seconds`],
  );
  const names = await profileNames(
    rows.flatMap((r) => (Array.isArray(r.players) ? r.players : []).map((p) => p.userId)),
  );
  return rows.map((r) => ({
    machine: r.machine,
    region: r.region,
    online: r.online,
    updatedAt: r.updated_at,
    players: (Array.isArray(r.players) ? r.players : []).map((p) => ({
      ...p,
      handle: names.get(p.userId)?.handle ?? null,
      username: names.get(p.userId)?.username ?? null,
      role: names.get(p.userId)?.role ?? null,
      known: names.get(p.userId)?.known ?? false,
    })),
    guests: Array.isArray(r.guests) ? r.guests : [],
    anon:
      r.anon && typeof r.anon === 'object' && typeof (r.anon as PresenceAnon).total === 'number'
        ? r.anon
        : { total: 0, inMatch: 0, inLobby: 0, idle: 0 },
  }));
}

// ---------------------------------------------------------- maintenance ----
/**
 * A scheduled MAINTENANCE LOCKDOWN: while it is live, only admins may start
 * anything. See 0023_maintenance.sql for why this lives in the database rather
 * than a machine's memory — it has to survive the restart it exists to protect,
 * and every region has to agree about it.
 */
export interface MaintenanceWindow {
  active: boolean;
  /** ms epoch it begins; null = the moment it was armed */
  startsAt: number | null;
  /** ms epoch it ends; null = open-ended ("until we say otherwise") */
  endsAt: number | null;
  message: string;
  /**
   * WHAT IS CLOSED (0051). `matches` is the original window: no new matches. `site` closes
   * the whole app, and the server refuses every write as well. Absent from an older
   * console's POST, which means `matches` — what that console meant.
   */
  scope?: LockdownScope;
  /** where the closed screen sends people (https only), and the button's label */
  redirectUrl?: string | null;
  redirectLabel?: string | null;
  /** the ACCESS GROUPS that pass this lockdown. Admins always pass and are not listed. */
  bypass?: AccessGroup[];
}

export type { LockdownScope, AccessGroup, BannerKind };
export { ACCESS_GROUPS, BANNER_KINDS };

/** the groups an account can be put in (0051). Each one passes a lockdown that lists it. */
export const isAccessGroup = (g: unknown): g is AccessGroup =>
  typeof g === 'string' && (ACCESS_GROUPS as readonly string[]).includes(g);

const NO_MAINTENANCE: MaintenanceWindow = {
  active: false,
  startsAt: null,
  endsAt: null,
  message: '',
  scope: 'matches',
  redirectUrl: null,
  redirectLabel: null,
  bypass: [],
};

export async function getMaintenance(): Promise<MaintenanceWindow> {
  const rows = await q<{
    active: boolean; starts_at: string | null; ends_at: string | null; message: string;
    scope: string | null; redirect_url: string | null; redirect_label: string | null; bypass: string[] | null;
  }>(
    `select active, starts_at, ends_at, message, scope, redirect_url, redirect_label, bypass
       from maintenance where id = 1`,
  );
  const r = rows[0];
  if (!r) return NO_MAINTENANCE;
  return {
    active: !!r.active,
    startsAt: r.starts_at ? new Date(r.starts_at).getTime() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).getTime() : null,
    message: r.message ?? '',
    scope: r.scope === 'site' ? 'site' : 'matches',
    redirectUrl: r.redirect_url ?? null,
    redirectLabel: r.redirect_label ?? null,
    bypass: (r.bypass ?? []).filter(isAccessGroup),
  };
}

export async function setMaintenance(w: MaintenanceWindow): Promise<MaintenanceWindow> {
  await q(
    `update maintenance
        set active = $1, starts_at = $2, ends_at = $3, message = $4, scope = $5,
            redirect_url = $6, redirect_label = $7, bypass = $8, updated_at = now()
      where id = 1`,
    [
      w.active,
      w.startsAt ? new Date(w.startsAt).toISOString() : null,
      w.endsAt ? new Date(w.endsAt).toISOString() : null,
      w.message ?? '',
      w.scope === 'site' ? 'site' : 'matches',
      w.redirectUrl || null,
      w.redirectLabel || null,
      (w.bypass ?? []).filter(isAccessGroup),
    ],
  );
  return getMaintenance();
}

/**
 * Is the lockdown BITING right now?
 *
 * Armed-but-not-yet-started deliberately does NOT lock. The point of scheduling a
 * window is to warn people before it takes effect, and a schedule that bites the
 * moment you set it cannot do that. A window whose end has passed also stops
 * biting on its own, so a lockdown somebody forgets to lift expires instead of
 * stranding the service until a human notices.
 */
export function maintenanceBiting(w: MaintenanceWindow, now = Date.now()): boolean {
  if (!w.active) return false;
  if (w.startsAt && now < w.startsAt) return false;
  if (w.endsAt && now >= w.endsAt) return false;
  return true;
}

/**
 * Does this caller get past the lockdown? Pure, so smoke and dbtest pin the same rule the
 * server enforces. Admins always do (the person deploying must be able to test what they
 * shipped, and the owner is an admin); otherwise membership of any group the lockdown lists.
 * A lockdown that is not biting lets everyone through.
 */
export function lockdownPasses(
  w: MaintenanceWindow,
  who: { admin: boolean; groups: readonly AccessGroup[] },
  now = Date.now(),
): boolean {
  if (!maintenanceBiting(w, now)) return true;
  if (who.admin) return true;
  const bypass = w.bypass ?? [];
  return who.groups.some((g) => bypass.includes(g));
}

// -------------------------------------------------------- access groups ----
/** one member row as the console lists it: the id is the key, the handle is today's name */
export interface AccessMember {
  userId: string;
  group: AccessGroup;
  handle: string | null;
  username: string | null;
  grantedBy: string;
  grantedAt: string;
  note: string;
}

/** the groups one account is in. The lockdown gate's read, cached per user in siteState.ts. */
export async function accessGroupsOf(userId: string): Promise<AccessGroup[]> {
  const rows = await q<{ grp: string }>(`select grp from access_members where user_id = $1`, [userId]);
  return rows.map((r) => r.grp).filter(isAccessGroup);
}

/** add an account to a group. Idempotent: a second grant keeps the first date and note. */
export async function grantAccess(
  userId: string,
  group: AccessGroup,
  grantedBy: string,
  note = '',
): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `insert into access_members (user_id, grp, granted_by, note) values ($1, $2, $3, $4)
     on conflict (user_id, grp) do nothing returning user_id`,
    [userId, group, grantedBy, note.slice(0, 200)],
  );
  return rows.length > 0;
}

/** take an account out of a group; false if it was not in it */
export async function revokeAccess(userId: string, group: AccessGroup): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `delete from access_members where user_id = $1 and grp = $2 returning user_id`,
    [userId, group],
  );
  return rows.length > 0;
}

/** every member, or one group's, newest first. Capped here, not by the route. */
export async function listAccessMembers(group?: AccessGroup, limit = 500): Promise<AccessMember[]> {
  return q<AccessMember>(
    `select a.user_id as "userId", a.grp as "group", p.handle, p.username,
            a.granted_by as "grantedBy", a.granted_at as "grantedAt", a.note
       from access_members a left join profiles p on p.user_id = a.user_id
      where ($1::text is null or a.grp = $1)
      order by a.granted_at desc, a.user_id
      limit $2`,
    [group ?? null, Math.min(Math.max(1, limit), 500)],
  );
}

/**
 * A PLAYER TAG TO AN ACCOUNT, for the grant form.
 *
 * Tried in order: an exact account id, an exact @username (unique), an exact display name
 * (case-insensitive). A display name is NOT unique, so two matches are an error that names
 * both @usernames rather than a guess. Resolved once, at grant time: membership is stored by
 * id, so a later rename does not drop anyone out of a group.
 */
export type TagResolution =
  | { ok: true; userId: string; handle: string; username: string | null }
  | { ok: false; error: string };
export async function resolvePlayerTag(tag: string): Promise<TagResolution> {
  const t = tag.trim();
  if (!t) return { ok: false, error: 'Empty tag.' };
  const bare = t.replace(/^@/, '');
  type Row = { user_id: string; handle: string; username: string | null };
  const byId = await q<Row>(`select user_id, handle, username from profiles where user_id = $1`, [t]);
  const byUsername = byId.length
    ? byId
    : await q<Row>(`select user_id, handle, username from profiles where username = lower($1)`, [bare]);
  if (byUsername.length) {
    const r = byUsername[0];
    return { ok: true, userId: r.user_id, handle: r.handle, username: r.username };
  }
  const byHandle = await q<Row>(
    `select user_id, handle, username from profiles where lower(handle) = lower($1)
      order by user_id limit 6`,
    [bare],
  );
  if (byHandle.length === 1) {
    const r = byHandle[0];
    return { ok: true, userId: r.user_id, handle: r.handle, username: r.username };
  }
  if (byHandle.length > 1) {
    const names = byHandle.map((r) => (r.username ? `@${r.username}` : r.user_id)).join(', ');
    return { ok: false, error: `“${t}” matches ${byHandle.length} players (${names}). Use the @username.` };
  }
  return { ok: false, error: `No player called “${t}”. They may need to sign in to this site once first.` };
}

// ---------------------------------------------------------------- banners ----
/** 0052. `restart` is the countdown; the other three are admin-authored notices. */
export const isBannerKind = (k: unknown): k is BannerKind =>
  typeof k === 'string' && (BANNER_KINDS as readonly string[]).includes(k);

export interface BannerRow {
  id: number;
  kind: BannerKind;
  message: string;
  startsAt: number | null;
  endsAt: number | null;
  game: string | null;
  channel: string | null;
  revision: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

type BannerDb = {
  id: string; kind: string; message: string; starts_at: string | null; ends_at: string | null;
  game: string | null; channel: string | null; revision: number; created_by: string;
  created_at: string; updated_at: string;
};
const BANNER_COLS = `id, kind, message, starts_at, ends_at, game, channel, revision, created_by, created_at, updated_at`;
const ms = (v: string | null): number | null => (v ? new Date(v).getTime() : null);
function bannerOf(r: BannerDb): BannerRow {
  return {
    id: Number(r.id),
    kind: isBannerKind(r.kind) ? r.kind : 'info',
    message: r.message,
    startsAt: ms(r.starts_at),
    endsAt: ms(r.ends_at),
    game: r.game,
    channel: r.channel,
    revision: r.revision,
    createdBy: r.created_by,
    createdAt: ms(r.created_at) ?? 0,
    updatedAt: ms(r.updated_at) ?? 0,
  };
}

/** every banner that has not ended, scheduled ones included (the cache filters by start) */
export async function listOpenBanners(): Promise<BannerRow[]> {
  const rows = await q<BannerDb>(
    // 30 s back: a restart countdown stays up for a 20 s grace past its end (siteState.ts)
    `select ${BANNER_COLS} from banners
      where ends_at is null or ends_at > now() - interval '30 seconds' order by id limit 100`,
  );
  return rows.map(bannerOf);
}

/** the console's list: open ones and the most recently ended, newest first */
export async function listBanners(limit = 60): Promise<BannerRow[]> {
  const rows = await q<BannerDb>(`select ${BANNER_COLS} from banners order by id desc limit $1`, [
    Math.min(Math.max(1, limit), 200),
  ]);
  return rows.map(bannerOf);
}

export interface BannerInput {
  kind: BannerKind;
  message: string;
  startsAt: number | null;
  endsAt: number | null;
  game: string | null;
  channel: string | null;
}
const iso = (v: number | null): string | null => (v ? new Date(v).toISOString() : null);

export async function createBanner(b: BannerInput, by: string): Promise<BannerRow> {
  const rows = await q<BannerDb>(
    `insert into banners (kind, message, starts_at, ends_at, game, channel, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning ${BANNER_COLS}`,
    [b.kind, b.message, iso(b.startsAt), iso(b.endsAt), b.game, b.channel, by],
  );
  return bannerOf(rows[0]);
}

/** edit in place. Bumps `revision`, so a player who dismissed the old text sees the new one. */
export async function updateBanner(id: number, b: BannerInput): Promise<BannerRow | null> {
  const rows = await q<BannerDb>(
    `update banners set kind = $2, message = $3, starts_at = $4, ends_at = $5, game = $6,
            channel = $7, revision = revision + 1, updated_at = now()
      where id = $1 returning ${BANNER_COLS}`,
    [id, b.kind, b.message, iso(b.startsAt), iso(b.endsAt), b.game, b.channel],
  );
  return rows[0] ? bannerOf(rows[0]) : null;
}

/** end now, keeping the row for the console's history. Backdated a minute so a restart
 *  countdown's grace (siteState.ts) does not keep it on screen. */
export async function endBanner(id: number): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `update banners set ends_at = now() - interval '1 minute', updated_at = now()
      where id = $1 and (ends_at is null or ends_at > now() - interval '30 seconds') returning id`,
    [id],
  );
  return rows.length > 0;
}

export async function deleteBanner(id: number): Promise<boolean> {
  const rows = await q<{ id: string }>(`delete from banners where id = $1 returning id`, [id]);
  return rows.length > 0;
}

/** end every open restart countdown — a new one replaces it, a cancel clears it */
export async function endRestartBanners(): Promise<number> {
  const rows = await q<{ id: string }>(
    `update banners set ends_at = now() - interval '1 minute', updated_at = now()
      where kind = 'restart' and (ends_at is null or ends_at > now() - interval '30 seconds') returning id`,
  );
  return rows.length;
}

/** aggregate presence over every machine heartbeating within `freshSeconds` (a few
 * missed beats). Sums sockets + ranked queues; de-dups signed-in users across regions
 * (a user connected from two regions counts once). */
export async function globalPresence(freshSeconds = 15): Promise<GlobalPresence> {
  const win = `${Math.max(1, Math.floor(freshSeconds))} seconds`;
  // ONE round trip, not two. This is the most-called query on the service and every
  // refresh used to cost a pair of statements — the sum, then a separate
  // `count(distinct)` over the same rows. Folding the distinct into a sub-select on a
  // shared CTE halves the per-refresh cost, which is what pays for the shorter cache
  // TTL in server/index.ts: accuracy and cost were traded against each other here, and
  // this is the move that buys both.
  const rows = await q<{
    online: number; q1: number; q2: number; signed_in: number; game_queues: unknown[];
  }>(
    `with fresh as (
       select * from presence where updated_at > now() - $1::interval
     )
     select coalesce(sum(online), 0)::int as online,
            coalesce(sum(q1v1), 0)::int as q1,
            coalesce(sum(q2v2), 0)::int as q2,
            (select count(distinct uid)::int
               from fresh f, jsonb_array_elements_text(f.authed) as uid) as signed_in,
            -- carried on the SAME round trip: this is the service's most-called
            -- query, and per-game depth is not worth a second one
            coalesce(jsonb_agg(game_queues), '[]'::jsonb) as game_queues
       from fresh`,
    [win],
  );
  const a = rows[0] ?? { online: 0, q1: 0, q2: 0, signed_in: 0, game_queues: [] };
  const gameQueues: Record<string, { '1v1': number; '2v2': number }> = {};
  for (const per of Array.isArray(a.game_queues) ? a.game_queues : []) addGameQueues(gameQueues, per);
  return {
    online: a.online,
    signedIn: a.signed_in ?? 0,
    queues: { '1v1': a.q1, '2v2': a.q2 },
    gameQueues,
  };
}

// ------------------------------------------------------------- friends ------
/**
 * Friends: a MUTUAL-CONSENT relation, plus presence, which is behavioural data
 * about a real person. Both are enforced here and in the handlers — never in the
 * client. The properties these functions exist to make structural:
 *
 *  - the acting user is ALWAYS the JWT `sub` the handler passes in; nothing here
 *    takes "who is acting" as data alongside "who to act on";
 *  - accept/decline/cancel/remove are CONDITIONAL writes scoped to the caller, and
 *    each returns false when it matched nothing — so naming a request that was
 *    never sent, or a friendship between two other people, is a 404 rather than a
 *    silent success;
 *  - presence is only ever reached THROUGH the caller's own friendship rows, so
 *    there is no query shape here that can return a non-friend's presence.
 */

/** a friend counts as online if their heartbeat landed within this window. The
 * client polls every ~30s, so 45s absorbs one missed beat without flapping. */
const ONLINE_WINDOW_S = 45;

export type PresenceStatus = 'online' | 'dnd' | 'invisible';

/** what a friend is doing right now — coarse and behavioural, reported by their
 * own heartbeat. null for an offline/invisible friend (blanked like last_seen). */
export type Activity = 'menu' | 'lobby' | 'match';

export interface FriendRow {
  userId: string;
  handle: string;
  username: string | null;
  online: boolean;
  /** 'dnd' shows a red dot; null = plain. NEVER 'invisible' — that is resolved
   * server-side into a plain offline row and is not observable by a friend. */
  status: 'dnd' | null;
  /** coarse seconds since last seen; null when online, never seen, or invisible.
   * Deliberately rounded (see `coarsen`) — the UI renders "3h", so second
   * precision would be a needlessly exact activity log to hand out. */
  offlineSeconds: number | null;
  /** 'menu' | 'lobby' | 'match' while online; null when offline/invisible/unknown */
  activity: Activity | null;
  /** which game they're in (a `GameId`) — only meaningful with `activity` */
  game: Game | null;
  /** the room to SPECTATE, set only while a match they are in is actually running
   *  (see `liveRoomsByUser`). Absent otherwise — including in a lobby, and for the
   *  seconds a finished room lingers. */
  watch?: { room: string; region: string; ranked: boolean };
  /** active supporter membership — renders a small badge beside the name */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge instead of the supporter one */
  role?: StaffRole;
}

export interface FriendsPayload {
  friends: FriendRow[];
  incoming: PublicProfile[];
  outgoing: PublicProfile[];
  blocked: PublicProfile[];
  invites: RoomInvite[];
  /** challenges the CALLER sent that are still live — so the sender can see
   * "waiting for @x", cancel it, and be told once when it was declined. Without
   * this a sent challenge was invisible to the person who sent it. */
  sent: SentInvite[];
  status: PresenceStatus | null;
}

/** round an offline duration to the granularity the UI actually renders */
function coarsen(sec: number | null): number | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return 0; // "just now"
  if (sec < 3600) return Math.round(sec / 300) * 300; // 5-minute buckets
  if (sec < 86400) return Math.round(sec / 3600) * 3600; // hourly
  return Math.round(sec / 86400) * 86400; // daily
}

/** record that this user is around. Folded into the friends READ (see api.ts)
 * rather than given its own ping endpoint: the poll that refreshes everyone
 * else's status already proves the caller is here, and with no user id on the
 * wire there is nothing to forge. */
export async function touchPresence(
  userId: string,
  activity: Activity | null = null,
  game: Game | null = null,
): Promise<void> {
  await q(
    `insert into user_presence (user_id, last_seen_at, activity, activity_game)
       values ($1, now(), $2, $3)
     on conflict (user_id) do update
       set last_seen_at = now(), activity = $2, activity_game = $3`,
    [userId, activity, game],
  );
}

export async function setPresenceStatus(
  userId: string,
  status: PresenceStatus | null,
): Promise<void> {
  await q(
    `insert into user_presence (user_id, last_seen_at, status) values ($1, now(), $2)
     on conflict (user_id) do update set last_seen_at = now(), status = $2`,
    [userId, status],
  );
}

/**
 * The caller's whole friends view in ONE round trip. Every row is reached through
 * the caller's own friendships/requests/blocks, so this cannot be coaxed into
 * returning a stranger's presence.
 *
 * It genuinely is one trip now. This used to be six sequential `q()` calls, each
 * taking its own connection from the pool and paying its own latency to Neon, and
 * it is the single most-called authenticated query on the site — the friends panel
 * polls it on a timer for as long as anyone has the app open. Six trips became one
 * by aggregating each result set to JSON in the same statement: the row counts here
 * are tiny (your friends, your pending requests, your blocks), so the aggregation
 * costs nothing next to five extra round trips.
 *
 * Ordering lives inside each `json_agg` on purpose — an `order by` in a CTE is not
 * guaranteed to survive aggregation, so the sort has to be attached to the
 * aggregate itself, not to the subquery feeding it.
 */
export async function listFriends(userId: string): Promise<FriendsPayload> {
  const rows = await q<{
    friends: {
      user_id: string;
      handle: string;
      username: string | null;
      status: string | null;
      since: number | string | null;
      activity: string | null;
      activity_game: string | null;
      role: string | null;
      supporter: boolean;
    }[];
    incoming: ProfileCols[];
    outgoing: ProfileCols[];
    blocked: ProfileCols[];
    invites: InviteCols[];
    sent: SentCols[];
    own_status: string | null;
  }>(
    `with pairs as (
       select case when user_low = $1 then user_high else user_low end as friend_id
         from friendships
        where user_low = $1 or user_high = $1
     ),
     f as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')},
              case when up.status = 'invisible' then null else up.status end as status,
              case when up.status = 'invisible' then null
                   else extract(epoch from (now() - up.last_seen_at)) end as since,
              case when up.status = 'invisible' then null else up.activity end as activity,
              case when up.status = 'invisible' then null else up.activity_game end as activity_game
         from pairs
         join profiles p on p.user_id = pairs.friend_id
         left join user_presence up on up.user_id = pairs.friend_id
     ),
     inc as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')}, fr.created_at
         from friend_requests fr join profiles p on p.user_id = fr.from_user_id
        where fr.to_user_id = $1
     ),
     outg as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')}, fr.created_at
         from friend_requests fr join profiles p on p.user_id = fr.to_user_id
        where fr.from_user_id = $1
     ),
     blk as (
       select p.user_id, p.handle, p.username, ${badgeCols('p.')}
         from friend_blocks b join profiles p on p.user_id = b.blocked_id
        where b.blocker_id = $1
     ),
     inv as (
       select ri.id, ri.from_user_id, p.handle, p.username, ${badgeCols('p.')},
              ri.room, ri.game, ri.kind, ri.record, ri.format, ri.region, ri.created_at
         from room_invites ri join profiles p on p.user_id = ri.from_user_id
        -- a DECLINED challenge is gone for its recipient the instant they decline;
        -- the row lingers only so the SENDER can be told (see the snt CTE below)
        where ri.to_user_id = $1 and not ri.declined
          and ri.created_at > now() - $2::interval
     ),
     snt as (
       select ri.id, ri.to_user_id, p.handle, p.username, ${badgeCols('p.')},
              ri.room, ri.game, ri.kind, ri.record, ri.format, ri.region, ri.declined, ri.created_at
         from room_invites ri join profiles p on p.user_id = ri.to_user_id
        where ri.from_user_id = $1 and ri.created_at > now() - $2::interval
     )
     select
       coalesce((select json_agg(f order by f.handle) from f), '[]'::json) as friends,
       coalesce((select json_agg(json_build_object(
         'user_id', inc.user_id, 'handle', inc.handle, 'username', inc.username,
         'role', inc.role, 'supporter', inc.supporter)
         order by inc.created_at desc) from inc), '[]'::json) as incoming,
       coalesce((select json_agg(json_build_object(
         'user_id', outg.user_id, 'handle', outg.handle, 'username', outg.username,
         'role', outg.role, 'supporter', outg.supporter)
         order by outg.created_at desc) from outg), '[]'::json) as outgoing,
       coalesce((select json_agg(json_build_object(
         'user_id', blk.user_id, 'handle', blk.handle, 'username', blk.username,
         'role', blk.role, 'supporter', blk.supporter)
         order by blk.handle) from blk), '[]'::json) as blocked,
       -- created_at is formatted EXPLICITLY rather than let json_agg serialize the
       -- timestamptz: Postgres would emit '...798296+00:00' where the pg driver's
       -- Date gives '...798Z'. Same instant, different string, and this one is
       -- handed to clients verbatim - so match the old wire format exactly.
       coalesce((select json_agg(json_build_object(
         'id', inv.id, 'from_user_id', inv.from_user_id, 'handle', inv.handle,
         'username', inv.username, 'role', inv.role, 'supporter', inv.supporter,
         'room', inv.room, 'game', inv.game,
         'kind', inv.kind, 'record', inv.record, 'format', inv.format, 'region', inv.region,
         'created_at', to_char(inv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         order by inv.created_at desc) from inv), '[]'::json) as invites,
       coalesce((select json_agg(json_build_object(
         'id', snt.id, 'to_user_id', snt.to_user_id, 'handle', snt.handle,
         'username', snt.username, 'role', snt.role, 'supporter', snt.supporter,
         'room', snt.room, 'game', snt.game,
         'kind', snt.kind, 'record', snt.record, 'format', snt.format, 'region', snt.region,
         'declined', snt.declined,
         'created_at', to_char(snt.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         order by snt.created_at desc) from snt), '[]'::json) as sent,
       (select status from user_presence where user_id = $1) as own_status`,
    [userId, `${INVITE_TTL_S} seconds`],
  );

  const row = rows[0];
  // where each friend is playing, for the Watch button. Resolved from the
  // heartbeat rather than from the friend's own activity beat: a client can claim
  // 'match' but cannot conjure a running room, and this is also the only source of
  // the hosting region. Never fatal — a failed lookup just costs the Watch buttons.
  const watchable = await liveRoomsByUser().catch((e) => {
    console.error('[friends] live-room lookup failed:', e);
    return new Map<string, UserLiveRoom>();
  });
  const friends: FriendRow[] = (row?.friends ?? []).map((r) => {
    const since = r.since === null ? null : Number(r.since);
    const online = since !== null && since <= ONLINE_WINDOW_S;
    // activity is meaningful only while online — an offline friend's LAST activity
    // is not something to report (they aren't doing it anymore)
    const activity =
      online && (r.activity === 'menu' || r.activity === 'lobby' || r.activity === 'match')
        ? (r.activity as Activity)
        : null;
    return {
      userId: r.user_id,
      handle: r.handle,
      username: r.username,
      online,
      status: r.status === 'dnd' ? 'dnd' : null,
      offlineSeconds: online ? null : coarsen(since),
      activity,
      game: activity ? coerceGameId(r.activity_game) : null,
      // `online` gates this so an invisible friend is never watchable: invisibility
      // nulls their last-seen, which is what `online` is computed from.
      watch: online ? watchable.get(r.user_id) : undefined,
      supporter: !!r.supporter,
      role: asRole(r.role),
    };
  });

  const st = row?.own_status ?? null;
  return {
    friends,
    incoming: (row?.incoming ?? []).map(shapeProfile),
    outgoing: (row?.outgoing ?? []).map(shapeProfile),
    blocked: (row?.blocked ?? []).map(shapeProfile),
    invites: (row?.invites ?? []).map(shapeInvite),
    sent: (row?.sent ?? []).map(shapeSent),
    status: st === 'online' || st === 'dnd' || st === 'invisible' ? st : null,
  };
}

/** the exact profile columns every friends query selects — an allowlist, never
 * `select *`: `profiles` also holds `settings`, and a future column would
 * otherwise join the payload silently.
 *
 * The two badge columns are part of the allowlist because these rows are NAMES ON
 * SCREEN — the friends list, the incoming/outgoing request lists, the challenge
 * toast — and a badge that appears on the leaderboard but not next to the same
 * person in your friends list reads as a bug. They cost nothing extra to read:
 * the `profiles` row is already joined, and this projects two more of its
 * columns rather than adding a lookup. */
interface ProfileCols {
  user_id: string;
  handle: string;
  username: string | null;
  role?: string | null;
  supporter?: boolean | null;
}
const shapeProfile = (r: ProfileCols): PublicProfile => ({
  userId: r.user_id,
  handle: r.handle,
  username: r.username,
  supporter: !!r.supporter,
  role: asRole(r.role),
});

/** the invite row shape, shared by `listFriends` (aggregated to JSON in one trip)
 * and `listRoomInvites` (its own query) so the two can never drift apart. */
interface InviteCols {
  id: string;
  from_user_id: string;
  handle: string;
  username: string | null;
  role: string | null;
  supporter: boolean | null;
  room: string;
  game: string;
  kind: string;
  record: string | null;
  format: string | null;
  region: string | null;
  created_at: string;
}
const shapeInvite = (r: InviteCols): RoomInvite => ({
  id: r.id,
  from: {
    userId: r.from_user_id,
    handle: r.handle,
    username: r.username,
    supporter: !!r.supporter,
    role: asRole(r.role),
  },
  room: r.room,
  game: coerceGameId(r.game),
  kind: r.kind,
  record: r.record,
  format: r.format,
  region: r.region,
  createdAt: r.created_at,
});

/** the same row seen from the SENDER's side: the other party is the recipient,
 * and `declined` is meaningful (the recipient's own list never shows a declined
 * challenge at all). */
interface SentCols extends Omit<InviteCols, 'from_user_id'> {
  to_user_id: string;
  declined: boolean;
}
const shapeSent = (r: SentCols): SentInvite => ({
  id: r.id,
  to: {
    userId: r.to_user_id,
    handle: r.handle,
    username: r.username,
    supporter: !!r.supporter,
    role: asRole(r.role),
  },
  room: r.room,
  game: coerceGameId(r.game),
  kind: r.kind,
  record: r.record,
  format: r.format,
  region: r.region,
  declined: !!r.declined,
  createdAt: r.created_at,
});

export type RequestOutcome = 'sent' | 'accepted' | 'already-friends' | 'blocked' | 'duplicate';

/**
 * Send a friend request. Returns an outcome instead of throwing so the handler
 * can map it to a status code.
 *
 * If the target has ALREADY sent the caller a request, this accepts it rather
 * than creating the mirror image — otherwise two people who both press Add end
 * up with two pending requests and no friendship, each looking at a request
 * they can't tell is already reciprocated.
 */
export async function sendFriendRequest(fromId: string, toId: string): Promise<RequestOutcome> {
  if (fromId === toId) return 'duplicate';
  return tx(async (query) => {
    // a block in EITHER direction stops the request. The handler reports this
    // the same way as an ordinary failure — telling a sender they were blocked
    // is itself the signal that lets someone confirm they were blocked.
    const blocks = await query<{ n: string }>(
      `select count(*) as n from friend_blocks
        where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`,
      [fromId, toId],
    );
    if (Number(blocks[0]?.n ?? 0) > 0) return 'blocked';

    const [low, high] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const already = await query(`select 1 from friendships where user_low = $1 and user_high = $2`, [
      low,
      high,
    ]);
    if (already.length > 0) return 'already-friends';

    const reverse = await query(
      `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
      [toId, fromId],
    );
    if (reverse.length > 0) {
      await query(
        `insert into friendships (user_low, user_high) values ($1, $2) on conflict do nothing`,
        [low, high],
      );
      return 'accepted';
    }

    const ins = await query(
      `insert into friend_requests (from_user_id, to_user_id) values ($1, $2)
       on conflict (from_user_id, to_user_id) do nothing returning 1`,
      [fromId, toId],
    );
    return ins.length > 0 ? 'sent' : 'duplicate';
  });
}

/**
 * Accept a pending request. The DELETE *is* the authorization check: it is
 * scoped to (from = the named sender, to = the CALLER), so it matches only a
 * request that person actually sent this caller, and the friendship is inserted
 * only when it matched. A read-then-write here would let a client accept a
 * request that was never sent and mint a friendship the other party never
 * agreed to — which then leaks that person's presence. False ⇒ handler 404s.
 */
export async function acceptFriendRequest(callerId: string, fromId: string): Promise<boolean> {
  if (callerId === fromId) return false;
  return tx(async (query) => {
    const del = await query(
      `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
      [fromId, callerId],
    );
    if (del.length === 0) return false;
    const [low, high] = callerId < fromId ? [callerId, fromId] : [fromId, callerId];
    await query(
      `insert into friendships (user_low, user_high) values ($1, $2) on conflict do nothing`,
      [low, high],
    );
    return true;
  });
}

/** decline a request sent TO the caller (caller is the `to` side) */
export async function declineFriendRequest(callerId: string, fromId: string): Promise<boolean> {
  const del = await q(
    `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
    [fromId, callerId],
  );
  return del.length > 0;
}

/** withdraw a request the caller SENT (caller is the `from` side) */
export async function cancelFriendRequest(callerId: string, toId: string): Promise<boolean> {
  const del = await q(
    `delete from friend_requests where from_user_id = $1 and to_user_id = $2 returning 1`,
    [callerId, toId],
  );
  return del.length > 0;
}

/** unfriend. One side of the pair is bound to the caller, so this can never
 * delete a friendship between two other people. */
export async function removeFriend(callerId: string, otherId: string): Promise<boolean> {
  const [low, high] = callerId < otherId ? [callerId, otherId] : [otherId, callerId];
  const del = await q(
    `delete from friendships where user_low = $1 and user_high = $2 returning 1`,
    [low, high],
  );
  return del.length > 0;
}

/** block someone: record it, then tear down the friendship and any pending
 * request in BOTH directions. Leaving the friendship in place would keep
 * leaking presence to the very person just blocked. */
export async function blockUser(callerId: string, targetId: string): Promise<boolean> {
  if (callerId === targetId) return false;
  return tx(async (query) => {
    await query(
      `insert into friend_blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`,
      [callerId, targetId],
    );
    const [low, high] = callerId < targetId ? [callerId, targetId] : [targetId, callerId];
    await query(`delete from friendships where user_low = $1 and user_high = $2`, [low, high]);
    await query(
      `delete from friend_requests
        where (from_user_id = $1 and to_user_id = $2) or (from_user_id = $2 and to_user_id = $1)`,
      [callerId, targetId],
    );
    return true;
  });
}

export async function unblockUser(callerId: string, targetId: string): Promise<boolean> {
  const del = await q(
    `delete from friend_blocks where blocker_id = $1 and blocked_id = $2 returning 1`,
    [callerId, targetId],
  );
  return del.length > 0;
}

// ------------------------------------------------------- room invites -------
/**
 * "Come join my room" for a friend, ridden on the same GET /api/friends read as
 * everything else here (no separate poll — see api.ts's block comment). Ephemeral:
 * a room outlives an invite by minutes, so expiry is enforced at READ time
 * (`INVITE_TTL_S`), not by a cron cleanup job.
 */
export interface RoomInvite {
  id: string;
  from: PublicProfile;
  /** for a casual/record challenge, the room code to join. For a RATED format
   * there is no room to join — this is the party token both sides hand the
   * matchmaker, which pairs them and stages the ranked match. */
  room: string;
  game: Game;
  kind: string;
  record: string | null;
  /** what was offered: 'casual1v1' | 'casual2v2' | 'rated1v1' | 'ranked2v2' |
   * 'duorecord'. Null on rows written before challenges carried a format, which
   * the client reads as the historical casual-versus meaning. */
  format: string | null;
  /** the REGION the room is hosted in. A custom code carries no region for the proxy to
   *  route on, so the recipient needs this to reach the machine the room is actually on;
   *  null on rows from a client older than the field. */
  region?: string | null;
  createdAt: string;
}

/** a challenge as its SENDER sees it — same row, other party, and `declined`
 * carries the one piece of news the sender is waiting on. */
export interface SentInvite extends Omit<RoomInvite, 'from'> {
  to: PublicProfile;
  declined: boolean;
}

const INVITE_TTL_S = 10 * 60;

export type InviteOutcome = 'sent' | 'not-friends';

/** invite a FRIEND to a room. Scoped to an existing friendship the same way a
 * friend request itself is scoped to a non-blocked pair — an invite is not a
 * new trust relationship, so it rides the one that already exists. */
export async function inviteToRoom(
  fromId: string,
  toId: string,
  room: string,
  game: Game,
  kind: string,
  record: string | null,
  format: string | null = null,
  /** the REGION the sender is hosting the room in. A custom room code is bare, so without
   *  this the recipient's socket routes to whichever machine is nearest to THEM — a
   *  different one, if the two players picked different servers, holding a different room
   *  with the same code. Empty ⇒ an older client; the recipient falls back to its own. */
  region: string | null = null,
): Promise<InviteOutcome> {
  const [low, high] = fromId < toId ? [fromId, toId] : [toId, fromId];
  const friend = await q(
    `select 1 from friendships where user_low = $1 and user_high = $2`,
    [low, high],
  );
  if (friend.length === 0) return 'not-friends';
  // One live challenge per direction. Spamming Challenge used to stack a row per
  // click, and for a RATED format that is worse than untidy: each row carries its
  // own party token, so the recipient could accept a stale one and sit in a
  // private queue waiting for a challenger who is already waiting under a
  // different token. Replacing keeps exactly one token in play.
  await q(`delete from room_invites where from_user_id = $1 and to_user_id = $2`, [fromId, toId]);
  await q(
    `insert into room_invites (from_user_id, to_user_id, room, game, kind, record, format, region)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [fromId, toId, room, game, kind, record, format, region || null],
  );
  return 'sent';
}

/**
 * Decline a challenge addressed to the caller. MARKS rather than deletes: the row
 * is what tells the sender their challenge was answered at all, and deleting it
 * makes a decline indistinguishable from being ignored. The sender's client
 * collects the news and then cancels it for real; one never collected falls out
 * of the read TTL like anything else here.
 */
export async function declineRoomInvite(userId: string, id: string): Promise<boolean> {
  const upd = await q(
    `update room_invites set declined = true where id = $1 and to_user_id = $2 returning 1`,
    [id, userId],
  );
  return upd.length > 0;
}

/** withdraw a challenge the caller SENT. Scoped to the sender, mirroring
 * `dismissRoomInvite`'s scoping to the recipient — neither can touch the other's
 * view of a row they don't own. */
export async function cancelRoomInvite(userId: string, id: string): Promise<boolean> {
  const del = await q(
    `delete from room_invites where id = $1 and from_user_id = $2 returning 1`,
    [id, userId],
  );
  return del.length > 0;
}

/**
 * A RATED challenge's `room` is its PARTY TOKEN (see `inviteToRoom`), and the token is spent the
 * instant the matchmaker stages the match it produced (`server/matchmaking.ts` `assign`): both
 * members passed `challengeParty` to be queued under it, and nothing reads the row again. Called
 * by the server, so it is not scoped to a party. A token is unguessable and names one challenge;
 * a bare ROOM CODE is neither, which is why the join path uses `clearRoomInvitesTo` instead.
 */
export async function clearRoomInvites(room: string): Promise<void> {
  await q(`delete from room_invites where room = $1`, [room]);
}

/** a casual challenge is spent when ITS RECIPIENT joins the room it named. Scoped to that
 * recipient: a host reconnecting to their own room, or a second friend joining the same lobby,
 * clears nothing that is still unanswered. */
export async function clearRoomInvitesTo(room: string, toUserId: string): Promise<void> {
  await q(`delete from room_invites where room = $1 and to_user_id = $2`, [room, toUserId]);
}

/**
 * Resolve a party token to the two accounts it belongs to, for a caller claiming
 * to be one of them. Returns null if there is no live challenge on that token
 * naming the caller.
 *
 * This is the matchmaker's gate for a RATED friend match, and it is not optional.
 * A party token is otherwise just a string two clients agreed on: without this
 * check any pair of clients could hand each other one and stage themselves a
 * rated, leaderboard-affecting match with no friendship, no challenge, and no
 * invite the other person ever saw. Returning the PAIR (rather than a yes/no) is
 * what lets the matchmaker also refuse to pair a token with anyone but its two
 * rightful members.
 */
export async function challengeParty(
  userId: string,
  token: string,
  format: string,
): Promise<{ from: string; to: string } | null> {
  const rows = await q<{ from_user_id: string; to_user_id: string }>(
    `select from_user_id, to_user_id from room_invites
      where room = $2 and format = $3 and created_at > now() - $4::interval
        and (from_user_id = $1 or to_user_id = $1)
      limit 1`,
    [userId, token, format, `${INVITE_TTL_S} seconds`],
  );
  const r = rows[0];
  return r ? { from: r.from_user_id, to: r.to_user_id } : null;
}

/** invites addressed to `userId`, freshest first, older than the TTL dropped. */
export async function listRoomInvites(userId: string): Promise<RoomInvite[]> {
  const rows = await q<{
    id: string;
    from_user_id: string;
    handle: string;
    username: string | null;
    role: string | null;
    supporter: boolean | null;
    room: string;
    game: string;
    kind: string;
    record: string | null;
    format: string | null;
    region: string | null;
    created_at: string;
  }>(
    `select ri.id, ri.from_user_id, p.handle, p.username, ${badgeCols('p.')},
            ri.room, ri.game, ri.kind, ri.record, ri.format, ri.region, ri.created_at
       from room_invites ri
       join profiles p on p.user_id = ri.from_user_id
      where ri.to_user_id = $1 and not ri.declined
        and ri.created_at > now() - $2::interval
      order by ri.created_at desc`,
    [userId, `${INVITE_TTL_S} seconds`],
  );
  return rows.map(shapeInvite);
}

/** dismiss (or consume, on join) an invite. Scoped to the RECIPIENT, so a
 * caller can never clear someone else's invite. */
export async function dismissRoomInvite(userId: string, id: string): Promise<boolean> {
  const del = await q(
    `delete from room_invites where id = $1 and to_user_id = $2 returning 1`,
    [id, userId],
  );
  return del.length > 0;
}

/**
 * Public user search for the "add a friend" box. Deliberately NOT `searchProfiles`
 * (the admin substring-on-handle search): a public substring search over display
 * names lets anyone enumerate every name on the service. This is a PREFIX match on
 * the unique `username` — the same public identifier already exposed one at a time
 * at /api/profile/<username>.
 */
export async function searchUsersByName(query: string, limit = 20): Promise<PublicProfile[]> {
  // Escape LIKE wildcards before appending `%`. Without this, searching for "%"
  // or "_" matches every row at once, turning a lookup back into the
  // full-enumeration endpoint this function exists to avoid.
  const esc = query.replace(/[\\%_]/g, '\\$&');
  const rows = await q<ProfileCols>(
    // Matches the @username OR the DISPLAY NAME. The handle match is a WORD prefix
    // (`kim` finds "Dohun Kim") rather than a free substring: a substring match makes
    // the endpoint a general "give me every name containing these two letters" probe,
    // and word-prefix covers what someone searching a name actually types. Display
    // names are already public on every leaderboard row, so this exposes no new field
    // — it changes how cheaply the set can be walked, which is why it stays bounded.
    //
    // `username is not null` because BOTH callers need one: the search bar opens
    // /profile/<username> and the friends box sends a request by username, so a row
    // without one is a dead result the UI has to disable.
    `select user_id, handle, username, ${badgeCols('')} from profiles
      where username is not null
        and (username ilike $1 escape '\\'
             or handle ilike $1 escape '\\'
             or handle ilike $2 escape '\\')
      order by
        -- the thing they typed most literally, first
        case when username ilike $1 escape '\\' then 0
             when handle ilike $1 escape '\\' then 1
             else 2 end,
        username
      limit $3`,
    [esc + '%', '% ' + esc + '%', Math.min(Math.max(1, limit), 50)],
  );
  return rows.map(shapeProfile);
}

// ============================================================ admin console ==
//
// The console's own data layer (migration 0041). Three jobs that the per-feature tables
// above could not do between them: one AUDIT LOG every mutating route writes to, private
// moderator NOTES on an account, and the single USER DETAIL read that every place a name
// appears can now open.
//
// ⚠️ EVERY LIST HERE IS PAGINATED AND HARD-CAPPED. An admin list is the one place in this
// codebase where "just fetch them all" looks harmless — there are only ever a handful of
// admins — and it is exactly where it is not: these tables grow with the SITE, not with the
// caller, so an unbounded `select … order by at desc` is a query whose cost rises forever and
// whose first slow day is an incident. The cap is applied HERE rather than by the route, for
// the reason `boardPhysics` is: a default in the data layer is the only version a new call
// site cannot forget.

/** one row of the audit log */
export interface AuditRow {
  id: string;
  adminId: string;
  action: string;
  targetUser: string | null;
  /** the target account's display name, resolved at read time (never stored — a name
   *  copied into the log would go stale the first time somebody is renamed) */
  targetHandle: string | null;
  targetUsername: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  note: string | null;
  at: string;
}

export interface AuditEntry {
  adminId: string;
  action: string;
  targetUser?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
  note?: string | null;
}

/**
 * Record one admin action.
 *
 * NEVER THROWS INTO A ROUTE — the same rule `server/standing.ts` states for the same reason.
 * The audit is bookkeeping about an action, not part of performing it: a moderator who has
 * just pardoned somebody must not see the pardon fail because a logging insert did. A failed
 * write is logged loudly to the console and swallowed.
 *
 * `detail` is server-authored in every caller. Nothing a client sends reaches it, which is
 * what keeps a jsonb column from becoming an injection surface for whatever a rename form
 * was talked into posting.
 */
export async function writeAudit(e: AuditEntry): Promise<void> {
  if (!dbEnabled) return;
  try {
    await q(
      `insert into admin_audit (admin_id, action, target_user, target_id, detail, note)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        e.adminId || 'unknown',
        e.action,
        e.targetUser ?? null,
        e.targetId ?? null,
        JSON.stringify(e.detail ?? {}),
        e.note ? e.note.slice(0, 500) : null,
      ],
    );
  } catch (err) {
    console.error('[audit] FAILED recording', e.action, 'by', e.adminId, err);
  }
}

/** the audit tab's read. Every filter is optional; the page is capped at 200. */
export async function listAudit(
  opts: {
    action?: string;
    adminId?: string;
    targetUser?: string;
    /** free text over the action, the note and the target id */
    query?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: AuditRow[]; more: boolean }> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.min(100_000, Math.floor(opts.offset ?? 0)));
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };
  if (opts.action) add('a.action = $?', opts.action);
  if (opts.adminId) add('a.admin_id = $?', opts.adminId);
  if (opts.targetUser) add('a.target_user = $?', opts.targetUser);
  if (opts.query?.trim()) {
    // escaped for the same reason `searchPublicProfiles` escapes: a bare `%` typed into the
    // box would otherwise match every row and turn a filter into a full scan. ONE parameter
    // reused across five columns — `add` fills only the first `$?`, so the placeholder is
    // resolved here and the clause handed over already complete.
    params.push(`%${opts.query.trim().replace(/[\\%_]/g, '\\$&')}%`);
    const n = `$${params.length}`;
    where.push(
      `(a.action ilike ${n} escape '\\' or a.note ilike ${n} escape '\\'` +
        ` or a.target_id ilike ${n} escape '\\' or a.target_user ilike ${n} escape '\\'` +
        ` or p.handle ilike ${n} escape '\\' or p.username ilike ${n} escape '\\')`,
    );
  }
  // one row more than asked for, so "is there another page" costs no second query
  params.push(limit + 1, offset);
  const rows = await q<{
    id: string; admin_id: string; action: string; target_user: string | null;
    handle: string | null; username: string | null;
    target_id: string | null; detail: Record<string, unknown> | null; note: string | null; at: string;
  }>(
    `select a.id::text as id, a.admin_id, a.action, a.target_user, a.target_id,
            a.detail, a.note, a.at, p.handle, p.username
       from admin_audit a
       left join profiles p on p.user_id = a.target_user
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by a.at desc, a.id desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return {
    rows: rows.slice(0, limit).map((r) => ({
      id: r.id,
      adminId: r.admin_id,
      action: r.action,
      targetUser: r.target_user,
      targetHandle: r.handle,
      targetUsername: r.username,
      targetId: r.target_id,
      detail: (r.detail ?? {}) as Record<string, unknown>,
      note: r.note,
      at: r.at,
    })),
    more: rows.length > limit,
  };
}

/** every distinct action seen in the log, for the filter menu. Bounded by the number of
 *  dotted keys the code can emit (a couple of dozen), not by the table's size. */
export async function auditActions(): Promise<string[]> {
  const rows = await q<{ action: string }>(
    `select distinct action from admin_audit order by action limit 100`,
  );
  return rows.map((r) => r.action);
}

// ------------------------------------------------------- account suspension ---

/**
 * SUSPENSION — the one moderation lever the console did not have (migration 0043).
 *
 * ⚠️ IT IS A DEADLINE, NOT A FLAG, and `null` means "not suspended". A suspension ends by
 * ARRIVING rather than by a second human action nothing schedules; see the migration for why
 * a boolean is the wrong shape. A permanent ban is a far-future date, which reads as a
 * decision rather than as somebody having forgotten to lift it.
 *
 * ⚠️ IT IS NOT STANDING. `standing_events` (0036) is the AUTOMATIC penalty ledger — sized to
 * heal on its own, read back to the player, and it locks ranked only. This is a human
 * decision that keeps somebody out of the rooms other people are in, and mixing the two would
 * mean either a moderator's ban decaying on a timer meant for a rage-quit, or a rage-quit
 * locking somebody out of the whole service.
 *
 * ⚠️ IT IS NOT A PRIVATE NOTE. `reason` is shown to the player at the door, in the
 * moderator's own words, because "you are suspended" with no sentence after it is the thing
 * that generates an appeal nobody can answer. Anything they should not read goes in
 * `admin_notes` and the console says so beside the box.
 */
export interface Suspension {
  /** ms epoch, or null when the account is not suspended */
  until: number | null;
  reason: string | null;
}

const NOT_SUSPENDED: Suspension = { until: null, reason: null };

/** Is this account suspended RIGHT NOW? Read at the room-join and ranked-queue doors, so it
 *  answers `NOT_SUSPENDED` for an id with no profile row and for an expired deadline — a gate
 *  whose unknown case refuses goes dark silently (the `emailGateRefusal` rule). */
export async function getSuspension(userId: string): Promise<Suspension> {
  if (!dbEnabled) return NOT_SUSPENDED;
  const rows = await q<{ until: string | null; reason: string | null }>(
    `select suspended_until as until, suspended_reason as reason
       from profiles where user_id = $1`,
    [userId],
  );
  const until = rows[0]?.until ? new Date(rows[0].until).getTime() : null;
  if (!until || !Number.isFinite(until) || until <= Date.now()) return NOT_SUSPENDED;
  return { until, reason: rows[0]?.reason ?? null };
}

/**
 * Suspend until `untilMs`, or LIFT with `null`. Returns the stored state, or `null` when no
 * such account exists — the route needs to tell "lifted" from "there was nobody to lift".
 *
 * Lifting clears the reason with the deadline: a sentence left behind on an account that is
 * no longer suspended is a line a later moderator reads as current.
 */
export async function setSuspension(
  userId: string,
  untilMs: number | null,
  reason: string | null,
): Promise<Suspension | null> {
  const until = untilMs != null && Number.isFinite(untilMs) && untilMs > Date.now() ? new Date(untilMs) : null;
  const rows = await q<{ until: string | null; reason: string | null }>(
    `update profiles set suspended_until = $2, suspended_reason = $3
      where user_id = $1
      returning suspended_until as until, suspended_reason as reason`,
    [userId, until, until ? (reason ?? '').slice(0, 300) || null : null],
  );
  if (rows.length === 0) return null;
  return {
    until: rows[0].until ? new Date(rows[0].until).getTime() : null,
    reason: rows[0].reason,
  };
}

// ------------------------------------------------------------ admin notes ---

export interface AdminNoteRow {
  id: string;
  adminId: string;
  note: string;
  at: string;
}

/** pin a private note to an account. Returns the stored row. */
export async function addAdminNote(
  userId: string,
  adminId: string,
  note: string,
): Promise<AdminNoteRow | null> {
  const text = note.trim().slice(0, 1000);
  if (!text) return null;
  const rows = await q<{ id: string; admin_id: string; note: string; at: string }>(
    `insert into admin_notes (user_id, admin_id, note) values ($1, $2, $3)
     returning id::text as id, admin_id, note, at`,
    [userId, adminId, text],
  );
  const r = rows[0];
  return r ? { id: r.id, adminId: r.admin_id, note: r.note, at: r.at } : null;
}

export async function listAdminNotes(userId: string, limit = 50): Promise<AdminNoteRow[]> {
  const rows = await q<{ id: string; admin_id: string; note: string; at: string }>(
    `select id::text as id, admin_id, note, at from admin_notes
      where user_id = $1 order by at desc limit $2`,
    [userId, Math.min(200, Math.max(1, Math.floor(limit)))],
  );
  return rows.map((r) => ({ id: r.id, adminId: r.admin_id, note: r.note, at: r.at }));
}

/** delete one note. Scoped by `user_id` as well as `id` so a mistyped id from one account's
 *  panel can never reach another's row. */
export async function deleteAdminNote(userId: string, id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `delete from admin_notes where user_id = $1 and id = $2::bigint returning id`,
    [userId, id],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------ user detail ---

/**
 * NAMES FOR A SET OF ACCOUNT IDS — the fix for "(no profile)".
 *
 * ⚠️ AN ACCOUNT WITH NO `profiles` ROW IS NOT A MISSING NAME, IT IS A DIFFERENT SITUATION,
 * and the admin console printed both as "(no profile)". `profiles` is created LAZILY —
 * `ensureProfile` runs on the API routes a signed-in client hits, so an account that has
 * authenticated and opened a socket but not yet reached one genuinely has no row — and the
 * operator view had no way to say which of the two it was looking at. `known` is that bit:
 * false means "this account really has no profile row yet", and every caller renders that as
 * the account id plus "no username yet", never as a missing lookup.
 */
export interface ProfileName {
  handle: string | null;
  username: string | null;
  role: StaffRole | null;
  /** a `profiles` row exists for this id */
  known: boolean;
}
export async function profileNames(userIds: string[]): Promise<Map<string, ProfileName>> {
  const out = new Map<string, ProfileName>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length || !dbEnabled) return out;
  const rows = await q<{ user_id: string; handle: string; username: string | null; role: string | null }>(
    `select user_id, handle, username, role from profiles where user_id = any($1::text[])`,
    [ids],
  );
  for (const r of rows) {
    out.set(r.user_id, {
      handle: r.handle,
      username: r.username,
      role: asRole(r.role) ?? null,
      known: true,
    });
  }
  return out;
}

export interface AdminUserDetail {
  userId: string;
  /** false ⇒ no `profiles` row at all (see `profileNames`) */
  known: boolean;
  handle: string | null;
  username: string | null;
  role: StaffRole | null;
  /** the PAID membership, deliberately — see `searchProfiles` for why the admin console
   *  never shows staff as supporters on a row where months get granted */
  supporter: boolean;
  supporterUntil: string | null;
  autoRenews: boolean;
  replaysPublic: boolean;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  createdAt: string | null;
  standing: StandingSnapshot | null;
  standingEvents: StandingEventRow[];
  /** reports filed AGAINST this account, and BY it — the second half is what tells a
   *  pattern from somebody working the report button */
  reportsAgainst: { total: number; open: number; reporters: number };
  reportsFiled: { total: number; rejected: number };
  scoreReportsFiled: { total: number; rejected: number };
  /** the ROWS behind those two counts — see `listReportsBy` for why a count is not enough */
  reportsAgainstList: ReportDetailRow[];
  reportsFiledList: ReportFiledRow[];
  /** null ⇒ not suspended. A deadline, not a flag — see `getSuspension` */
  suspension: Suspension;
  notes: AdminNoteRow[];
  grants: SupporterGrantRow[];
  /** Ko-fi payments this account claimed, so a chargeback can be flagged against the
   *  transaction it belongs to rather than against the months it bought */
  payments: KofiPaymentRow[];
  recentMatches: Awaited<ReturnType<typeof userRecentMatches>>;
  records: { recordId: string; game: string; mode: string; drivetrain: string; score: number; replayId: string | null; createdAt: string }[];
  audit: AuditRow[];
}

/**
 * EVERYTHING ABOUT ONE ACCOUNT, IN ONE REQUEST.
 *
 * The console used to answer "who is this person" from four places that did not know about
 * each other: the Live table had a name, the report queue had counts, the standing editor had
 * the ledger, and the user search had the membership. A moderator deciding what to do about
 * somebody had to open all four and hold the answer in their head.
 *
 * Every query here is bounded, and they run CONCURRENTLY rather than in sequence — this is one
 * page load, not a pipeline, and nine round trips at 30ms each is a third of a second of
 * staring at a spinner for no reason. An id with no profile row still answers (with `known:
 * false`), because "this session says it is signed in and there is no account behind it" is
 * precisely the thing an operator needs to be shown rather than protected from.
 */
export async function adminUserDetail(userId: string): Promise<AdminUserDetail> {
  const [
    prof, standings, events, against, filed, scoreFiled, notes, grants, matches, records, audit,
    againstList, filedList, payments,
  ] =
    await Promise.all([
      q<{
        handle: string; username: string | null; role: string | null; supporter: boolean;
        supporter_until: string | null; auto_renews: boolean; replays_public: boolean;
        terms_version: string | null; terms_accepted_at: string | null; created_at: string | null;
        suspended_until: string | null; suspended_reason: string | null;
      }>(
        `select handle, username, role,
                (supporter_until is not null and supporter_until > now()) as supporter,
                supporter_until, (kofi_email is not null) as auto_renews,
                coalesce(replays_public, false) as replays_public,
                terms_version, terms_accepted_at, created_at,
                suspended_until, suspended_reason
           from profiles where user_id = $1`,
        [userId],
      ),
      standingsFor([userId]),
      listStandingEvents(userId, 50),
      q<{ total: number; open: number; reporters: number }>(
        `select count(*)::int as total,
                count(*) filter (where status = 'open')::int as open,
                count(distinct reporter_id)::int as reporters
           from player_reports where reported_id = $1`,
        [userId],
      ),
      q<{ total: number; rejected: number }>(
        `select count(*)::int as total,
                count(*) filter (where status = 'dismissed')::int as rejected
           from player_reports where reporter_id = $1`,
        [userId],
      ),
      q<{ total: number; rejected: number }>(
        `select count(*)::int as total,
                count(*) filter (where status = 'rejected')::int as rejected
           from score_reports where reporter_id = $1`,
        [userId],
      ),
      listAdminNotes(userId, 50),
      listSupporterGrants(userId, 20),
      userRecentMatches(userId, 20),
      q<{ id: string; game: string; mode: string; drivetrain: string; score: number; replay_id: string | null; created_at: string }>(
        `select id::text as id, game, mode, drivetrain, score, replay_id::text as replay_id, created_at
           from records where user_id = $1 order by created_at desc limit 20`,
        [userId],
      ),
      listAudit({ targetUser: userId, limit: 25 }),
      listReportsFor(userId, 50),
      listReportsBy(userId, 50),
      listKofiPayments(userId, 20),
    ]);
  const p = prof[0];
  // read off the row already fetched rather than re-querying: `getSuspension` is the door's
  // read and this is the panel's, and they must agree about an EXPIRED deadline being "not
  // suspended" rather than "suspended, in the past".
  const suspendedUntil = p?.suspended_until ? new Date(p.suspended_until).getTime() : null;
  const suspended = suspendedUntil != null && Number.isFinite(suspendedUntil) && suspendedUntil > Date.now();
  return {
    userId,
    known: !!p,
    handle: p?.handle ?? null,
    username: p?.username ?? null,
    role: asRole(p?.role ?? null) ?? null,
    supporter: !!p?.supporter,
    supporterUntil: p?.supporter_until ?? null,
    autoRenews: !!p?.auto_renews,
    replaysPublic: !!p?.replays_public,
    termsVersion: p?.terms_version ?? null,
    termsAcceptedAt: p?.terms_accepted_at ?? null,
    createdAt: p?.created_at ?? null,
    standing: standings[userId] ?? null,
    standingEvents: events,
    reportsAgainst: {
      total: Number(against[0]?.total ?? 0),
      open: Number(against[0]?.open ?? 0),
      reporters: Number(against[0]?.reporters ?? 0),
    },
    reportsFiled: { total: Number(filed[0]?.total ?? 0), rejected: Number(filed[0]?.rejected ?? 0) },
    scoreReportsFiled: {
      total: Number(scoreFiled[0]?.total ?? 0),
      rejected: Number(scoreFiled[0]?.rejected ?? 0),
    },
    reportsAgainstList: againstList,
    reportsFiledList: filedList,
    suspension: suspended
      ? { until: suspendedUntil, reason: p?.suspended_reason ?? null }
      : { until: null, reason: null },
    notes,
    grants,
    payments,
    recentMatches: matches,
    records: records.map((r) => ({
      recordId: r.id,
      game: r.game,
      mode: r.mode,
      drivetrain: r.drivetrain,
      score: r.score,
      replayId: r.replay_id,
      createdAt: r.created_at,
    })),
    audit: audit.rows,
  };
}
