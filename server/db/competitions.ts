/**
 * COMPETITIONS — the data layer (migration 0059). SQL only: who may do what, and what a change
 * means for the rest of the competition, is `server/competitions.ts`.
 *
 * Every list is bounded here, not by the caller (`docs/area/accounts.md`: "EVERY LIST IS PAGED
 * AND HARD-CAPPED IN THE DATA LAYER"). A competition is at most 256 entries and its schedule a
 * few hundred matches, so the per-competition reads return the whole thing in one query each.
 */
import { q, tx, type Tx } from './pool';
import { badgeCols } from './repo';
import type {
  CompFormat,
  CompResult,
  CompSlot,
  CompStatus,
  EntryStatus,
  MatchStage,
  PlayoffAlliance,
  SelectionAction,
  SeriesSpec,
  TeamMode,
  CompMatchStatus,
} from '../../src/competition/types';
import type { GameId } from '../../src/games/types';

const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());
const msReq = (v: unknown): number => new Date(v as string).getTime();

// ------------------------------------------------------------------ competitions

export interface CompRow {
  id: string;
  slug: string;
  name: string;
  game: GameId;
  format: CompFormat;
  teamMode: TeamMode;
  status: CompStatus;
  visibility: 'public' | 'unlisted';
  official: boolean;
  summary: string;
  description: string;
  rules: string;
  /** raw jsonb; coerce before use */
  settings: unknown;
  capacity: number;
  region: string | null;
  regOpensAt: number | null;
  regClosesAt: number | null;
  checkinOpensAt: number | null;
  startsAt: number | null;
  rngSeed: number;
  seedOrder: number[] | null;
  selection: SelectionAction[];
  alliances: PlayoffAlliance[] | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  /** list reads only */
  entrants?: number;
  waitlist?: number;
  champions?: string[];
}

interface CompDbRow {
  id: string;
  slug: string;
  name: string;
  game: string;
  format: string;
  team_mode: string;
  status: string;
  visibility: string;
  official: boolean;
  summary: string;
  description: string;
  rules: string;
  settings: unknown;
  capacity: number;
  region: string | null;
  reg_opens_at: string | null;
  reg_closes_at: string | null;
  checkin_opens_at: string | null;
  starts_at: string | null;
  rng_seed: string;
  seed_order: number[] | null;
  selection: SelectionAction[] | null;
  alliances: PlayoffAlliance[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  entrants?: string;
  waitlist?: string;
  champions?: string[] | null;
}

function compOf(r: CompDbRow): CompRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    game: r.game as GameId,
    format: r.format as CompFormat,
    teamMode: r.team_mode as TeamMode,
    status: r.status as CompStatus,
    visibility: r.visibility === 'unlisted' ? 'unlisted' : 'public',
    official: r.official,
    summary: r.summary,
    description: r.description,
    rules: r.rules,
    settings: r.settings,
    capacity: r.capacity,
    region: r.region,
    regOpensAt: ms(r.reg_opens_at),
    regClosesAt: ms(r.reg_closes_at),
    checkinOpensAt: ms(r.checkin_opens_at),
    startsAt: ms(r.starts_at),
    rngSeed: Number(r.rng_seed),
    seedOrder: Array.isArray(r.seed_order) ? r.seed_order.map(Number) : null,
    selection: Array.isArray(r.selection) ? r.selection : [],
    alliances: Array.isArray(r.alliances) ? r.alliances : null,
    createdBy: r.created_by,
    createdAt: msReq(r.created_at),
    updatedAt: msReq(r.updated_at),
    startedAt: ms(r.started_at),
    completedAt: ms(r.completed_at),
    cancelledAt: ms(r.cancelled_at),
    ...(r.entrants !== undefined ? { entrants: Number(r.entrants) } : {}),
    ...(r.waitlist !== undefined ? { waitlist: Number(r.waitlist) } : {}),
    ...(r.champions !== undefined ? { champions: (r.champions ?? []).filter(Boolean) } : {}),
  };
}

const LIST_COLS = `c.*,
  (select count(*) from competition_entries e where e.competition_id = c.id and e.status = 'registered') as entrants,
  (select count(*) from competition_entries e where e.competition_id = c.id and e.status = 'waitlist') as waitlist,
  (select array_agg(e.name order by e.id) from competition_entries e
     where e.competition_id = c.id and e.placement = 1) as champions`;

export interface NewCompetition {
  slug: string;
  name: string;
  game: GameId;
  format: CompFormat;
  teamMode: TeamMode;
  visibility: 'public' | 'unlisted';
  official: boolean;
  summary: string;
  description: string;
  rules: string;
  settings: unknown;
  capacity: number;
  region: string | null;
  regOpensAt: number | null;
  regClosesAt: number | null;
  checkinOpensAt: number | null;
  startsAt: number | null;
  rngSeed: number;
  createdBy: string;
}

const ts = (v: number | null): string | null => (v == null ? null : new Date(v).toISOString());

/** a new draft; a taken slug gets `-2`, `-3`, … appended */
export async function insertCompetition(c: NewCompetition): Promise<CompRow> {
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? c.slug : `${c.slug.slice(0, 44)}-${n}`;
    const rows = await q<CompDbRow>(
      `insert into competitions (slug, name, game, format, team_mode, visibility, official, summary, description, rules,
                                 settings, capacity, region, reg_opens_at, reg_closes_at, checkin_opens_at, starts_at,
                                 rng_seed, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (slug) do nothing
       returning *`,
      [
        slug, c.name, c.game, c.format, c.teamMode, c.visibility, c.official, c.summary, c.description, c.rules,
        JSON.stringify(c.settings ?? {}), c.capacity, c.region, ts(c.regOpensAt), ts(c.regClosesAt),
        ts(c.checkinOpensAt), ts(c.startsAt), String(c.rngSeed), c.createdBy,
      ],
    );
    if (rows[0]) return compOf(rows[0]);
  }
  throw new Error('no free slug');
}

export async function getCompetition(key: { slug?: string; id?: string }): Promise<CompRow | null> {
  const rows = key.id
    ? await q<CompDbRow>(`select ${LIST_COLS} from competitions c where c.id = $1`, [key.id])
    : await q<CompDbRow>(`select ${LIST_COLS} from competitions c where c.slug = $1`, [key.slug ?? '']);
  return rows[0] ? compOf(rows[0]) : null;
}

export type ListScope = 'live' | 'upcoming' | 'past' | 'drafts' | 'all';

/**
 * The public list, by scope. `hidden` admits drafts and unlisted competitions (staff only).
 * `mine` restricts to competitions the user entered or staffs.
 */
export async function listCompetitions(o: {
  scope: ListScope;
  game?: GameId | null;
  hidden: boolean;
  mine?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ rows: CompRow[]; more: boolean }> {
  const limit = Math.min(Math.max(o.limit ?? 24, 1), 60);
  const offset = Math.min(Math.max(o.offset ?? 0, 0), 5000);
  const where: string[] = [];
  const params: unknown[] = [];
  const order = {
    live: `c.started_at desc nulls last, c.created_at desc`,
    upcoming: `c.starts_at asc nulls last, c.created_at desc`,
    past: `coalesce(c.completed_at, c.cancelled_at, c.updated_at) desc`,
    drafts: `c.updated_at desc`,
    all: `c.updated_at desc`,
  }[o.scope];
  if (o.scope === 'live') where.push(`c.status in ('qualification','selection','playoffs')`);
  if (o.scope === 'upcoming') where.push(`c.status = 'published'`);
  if (o.scope === 'past') where.push(`c.status in ('completed','cancelled')`);
  if (o.scope === 'drafts') where.push(`c.status = 'draft'`);
  if (!o.hidden) where.push(`c.status <> 'draft' and c.visibility = 'public'`);
  if (o.game) {
    params.push(o.game);
    where.push(`c.game = $${params.length}`);
  }
  if (o.mine) {
    params.push(o.mine);
    where.push(`(exists (select 1 from competition_entries e where e.competition_id = c.id
                          and (e.user_id = $${params.length} or e.partner_id = $${params.length})
                          and e.status <> 'withdrawn')
               or exists (select 1 from competition_staff s where s.competition_id = c.id and s.user_id = $${params.length}))`);
  }
  params.push(limit + 1, offset);
  const rows = await q<CompDbRow>(
    `select ${LIST_COLS} from competitions c
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by ${order}, c.id
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { rows: rows.slice(0, limit).map(compOf), more: rows.length > limit };
}

/** the columns `updateCompetition` may write, camelCase → column */
const EDITABLE: Record<string, string> = {
  name: 'name',
  game: 'game',
  format: 'format',
  teamMode: 'team_mode',
  visibility: 'visibility',
  summary: 'summary',
  description: 'description',
  rules: 'rules',
  capacity: 'capacity',
  region: 'region',
  regOpensAt: 'reg_opens_at',
  regClosesAt: 'reg_closes_at',
  checkinOpensAt: 'checkin_opens_at',
  startsAt: 'starts_at',
  settings: 'settings',
  status: 'status',
  seedOrder: 'seed_order',
  selection: 'selection',
  alliances: 'alliances',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  cancelledAt: 'cancelled_at',
};
const JSON_COLS = new Set(['settings', 'seed_order', 'selection', 'alliances']);
const TIME_COLS = new Set(['reg_opens_at', 'reg_closes_at', 'checkin_opens_at', 'starts_at', 'started_at', 'completed_at', 'cancelled_at']);

/**
 * Write the named fields. `expectStatus` makes it conditional on the status the caller read,
 * so two organizers pressing different buttons at once cannot both win.
 */
export async function updateCompetition(
  id: string,
  patch: Record<string, unknown>,
  expectStatus?: CompStatus | CompStatus[],
  query: Tx = q,
): Promise<CompRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    const col = EDITABLE[k];
    if (!col || v === undefined) continue;
    if (JSON_COLS.has(col)) {
      params.push(v === null ? null : JSON.stringify(v));
      sets.push(`${col} = $${params.length}::jsonb`);
    } else if (TIME_COLS.has(col)) {
      params.push(typeof v === 'number' ? new Date(v).toISOString() : null);
      sets.push(`${col} = $${params.length}`);
    } else {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return getCompetition({ id });
  let cond = '';
  if (expectStatus) {
    params.push(Array.isArray(expectStatus) ? expectStatus : [expectStatus]);
    cond = ` and status = any($${params.length}::text[])`;
  }
  const rows = await query<CompDbRow>(
    `update competitions set ${sets.join(', ')}, updated_at = now() where id = $1${cond} returning *`,
    params,
  );
  return rows[0] ? compOf(rows[0]) : null;
}

export async function deleteCompetition(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(`delete from competitions where id = $1 returning id`, [id]);
  return rows.length > 0;
}

/** competitions with matches to run: what the runner sweeps */
export async function runningCompetitions(): Promise<CompRow[]> {
  const rows = await q<CompDbRow>(
    `select ${LIST_COLS} from competitions c where c.status in ('qualification','playoffs') order by c.started_at limit 100`,
  );
  return rows.map(compOf);
}

/** how many competitions one account created and has not finished (the creation cap) */
export async function openCompetitionsBy(userId: string): Promise<number> {
  const rows = await q<{ n: string }>(
    `select count(*) as n from competitions where created_by = $1 and status not in ('completed','cancelled')`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------------- staff

export interface StaffRow {
  userId: string;
  role: 'organizer' | 'referee';
  handle: string | null;
  username: string | null;
  staffRole: 'owner' | 'admin' | null;
  supporter: boolean;
  badges: unknown;
}

export async function listStaff(competitionId: string): Promise<StaffRow[]> {
  return q<StaffRow>(
    `select s.user_id as "userId", s.role, p.handle, p.username, ${badgeCols('p.').replace('role as role', 'role as "staffRole"')}
       from competition_staff s join profiles p on p.user_id = s.user_id
      where s.competition_id = $1 order by s.added_at limit 50`,
    [competitionId],
  );
}

export async function staffRoleOf(competitionId: string, userId: string): Promise<'organizer' | 'referee' | null> {
  const rows = await q<{ role: string }>(
    `select role from competition_staff where competition_id = $1 and user_id = $2`,
    [competitionId, userId],
  );
  const r = rows[0]?.role;
  return r === 'organizer' || r === 'referee' ? r : null;
}

export async function setStaff(competitionId: string, userId: string, role: 'organizer' | 'referee', by: string): Promise<void> {
  await q(
    `insert into competition_staff (competition_id, user_id, role, added_by) values ($1,$2,$3,$4)
     on conflict (competition_id, user_id) do update set role = excluded.role`,
    [competitionId, userId, role, by],
  );
}

export async function removeStaff(competitionId: string, userId: string): Promise<boolean> {
  const rows = await q<{ user_id: string }>(
    `delete from competition_staff where competition_id = $1 and user_id = $2 returning user_id`,
    [competitionId, userId],
  );
  return rows.length > 0;
}

// ----------------------------------------------------------------------- entries

export interface EntryRow {
  id: number;
  competitionId: string;
  userId: string | null;
  partnerId: string | null;
  name: string;
  number: number | null;
  status: EntryStatus;
  checkedInAt: number | null;
  seed: number | null;
  placement: number | null;
  note: string | null;
  registeredAt: number;
  handle: string | null;
  username: string | null;
  role: 'owner' | 'admin' | null;
  supporter: boolean;
  badges: unknown;
  partnerHandle: string | null;
  partnerUsername: string | null;
  partnerRole: 'owner' | 'admin' | null;
  partnerSupporter: boolean;
  partnerBadges: unknown;
}

interface EntryDbRow extends Omit<EntryRow, 'id' | 'checkedInAt' | 'registeredAt'> {
  id: string;
  checkedInAt: string | null;
  registeredAt: string;
}

const entryOf = (r: EntryDbRow): EntryRow => ({
  ...r,
  id: Number(r.id),
  checkedInAt: ms(r.checkedInAt),
  registeredAt: msReq(r.registeredAt),
});

/** a function, not a constant: `badgeCols` reads module state in repo.ts, and a constant built at
 *  import time would read it before repo.ts has run if the import graph ever closes a cycle */
const entrySelect = (): string => `
  select e.id, e.competition_id as "competitionId", e.user_id as "userId", e.partner_id as "partnerId",
         e.name, e.number, e.status, e.checked_in_at as "checkedInAt", e.seed, e.placement, e.note,
         e.registered_at as "registeredAt",
         p.handle, p.username, ${badgeCols('p.')},
         pp.handle as "partnerHandle", pp.username as "partnerUsername", ${badgeCols('pp.', 'partner')}
    from competition_entries e
    left join profiles p on p.user_id = e.user_id
    left join profiles pp on pp.user_id = e.partner_id`;

export async function listEntries(competitionId: string, query: Tx = q): Promise<EntryRow[]> {
  const rows = await query<EntryDbRow>(
    `${entrySelect()} where e.competition_id = $1 order by e.registered_at, e.id limit 600`,
    [competitionId],
  );
  return rows.map(entryOf);
}

/** the entry a user holds in a competition, as captain or as partner (or invited partner) */
export async function entryOfUser(competitionId: string, userId: string, query: Tx = q): Promise<EntryRow | null> {
  const rows = await query<EntryDbRow>(
    `${entrySelect()} where e.competition_id = $1 and (e.user_id = $2 or e.partner_id = $2)
      order by (e.status = 'withdrawn'), e.id limit 1`,
    [competitionId, userId],
  );
  return rows[0] ? entryOf(rows[0]) : null;
}

export async function getEntry(id: number, query: Tx = q): Promise<EntryRow | null> {
  const rows = await query<EntryDbRow>(`${entrySelect()} where e.id = $1`, [id]);
  return rows[0] ? entryOf(rows[0]) : null;
}

export async function insertEntry(
  e: { competitionId: string; userId: string; partnerId: string | null; name: string; number: number | null; status: EntryStatus },
  query: Tx = q,
): Promise<number> {
  const rows = await query<{ id: string }>(
    `insert into competition_entries (competition_id, user_id, partner_id, name, number, status)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [e.competitionId, e.userId, e.partnerId, e.name, e.number, e.status],
  );
  return Number(rows[0].id);
}

/** write the named entry fields */
export async function updateEntry(
  id: number,
  patch: Partial<{ status: EntryStatus; checkedIn: boolean; seed: number | null; name: string; number: number | null; note: string | null; placement: number | null; partnerId: string | null; userId: string | null }>,
  query: Tx = q,
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const put = (col: string, v: unknown): void => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.checkedIn !== undefined) sets.push(`checked_in_at = ${patch.checkedIn ? 'coalesce(checked_in_at, now())' : 'null'}`);
  if (patch.seed !== undefined) put('seed', patch.seed);
  if (patch.name !== undefined) put('name', patch.name);
  if (patch.number !== undefined) put('number', patch.number);
  if (patch.note !== undefined) put('note', patch.note);
  if (patch.placement !== undefined) put('placement', patch.placement);
  if (patch.partnerId !== undefined) put('partner_id', patch.partnerId);
  if (patch.userId !== undefined) put('user_id', patch.userId);
  if (!sets.length) return false;
  const rows = await query<{ id: string }>(`update competition_entries set ${sets.join(', ')} where id = $1 returning id`, params);
  return rows.length > 0;
}

/**
 * FREE A PLAYER'S PARTNER PLACE on the WITHDRAWN entries of one competition, so somebody else may
 * name them. `partner_id` is unique per competition and a withdrawn duo keeps its row (that is how
 * its captain comes back as a new arrival), so without this the partner of a duo that withdrew
 * could never be invited again: the insert hit `competition_entries_partner_uq` and the sign-up
 * failed as a 500. Only ever called before the competition starts, when a withdrawn entry has
 * played nothing, so the row loses no history. `keep` is a row the caller is about to reuse.
 */
export async function releaseWithdrawnPartner(competitionId: string, userId: string, keep: number | null, query: Tx = q): Promise<void> {
  await query(
    `update competition_entries set partner_id = null
      where competition_id = $1 and partner_id = $2 and status = 'withdrawn' and id <> coalesce($3::bigint, 0)`,
    [competitionId, userId, keep],
  );
}

export async function deleteEntry(id: number, query: Tx = q): Promise<boolean> {
  const rows = await query<{ id: string }>(`delete from competition_entries where id = $1 returning id`, [id]);
  return rows.length > 0;
}

/** clear every placement, then write the given ones (the competition completing) */
export async function writePlacements(competitionId: string, places: Map<number, number>, query: Tx = q): Promise<void> {
  await query(`update competition_entries set placement = null where competition_id = $1`, [competitionId]);
  const ids = [...places.keys()];
  if (!ids.length) return;
  await query(
    `update competition_entries e set placement = p.place
       from unnest($2::bigint[], $3::int[]) as p(id, place)
      where e.id = p.id and e.competition_id = $1`,
    [competitionId, ids, ids.map((i) => places.get(i) ?? 0)],
  );
}

/** the lock every registration takes, so two sign-ups cannot both take the last place */
export async function lockCompetition(query: Tx, id: string): Promise<CompRow | null> {
  const rows = await query<CompDbRow>(`select * from competitions where id = $1 for update`, [id]);
  return rows[0] ? compOf(rows[0]) : null;
}

export { tx };

// ----------------------------------------------------------------------- matches

export interface MatchRow {
  id: number;
  competitionId: string;
  stage: MatchStage;
  round: number;
  number: number;
  series: string | null;
  status: CompMatchStatus;
  attempt: number;
  roomCode: string | null;
  calledAt: number | null;
  claimedAt: number | null;
  finishedAt: number | null;
  result: CompResult | null;
  dq: number[];
  matchId: string | null;
  replayId: string | null;
  note: string | null;
  callNote: string | null;
  red: CompSlot[];
  blue: CompSlot[];
}

interface MatchDbRow {
  id: string;
  competition_id: string;
  stage: string;
  round: number;
  number: number;
  series_key: string | null;
  status: string;
  attempt: number;
  room_code: string | null;
  called_at: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  red_score: number | null;
  blue_score: number | null;
  red_foul: number;
  blue_foul: number;
  winner: string | null;
  source: string | null;
  dq: (string | number)[] | null;
  match_id: string | null;
  replay_id: string | null;
  note: string | null;
  call_note: string | null;
  slots: { a: string; i: number; e: string | number; s: boolean }[] | null;
}

function matchOf(r: MatchDbRow): MatchRow {
  const slots = (r.slots ?? []).slice().sort((x, y) => x.i - y.i);
  const side = (a: 'red' | 'blue'): CompSlot[] =>
    slots.filter((s) => s.a === a).map((s) => (s.s ? { entry: Number(s.e), surrogate: true } : { entry: Number(s.e) }));
  return {
    id: Number(r.id),
    competitionId: r.competition_id,
    stage: r.stage as MatchStage,
    round: r.round,
    number: r.number,
    series: r.series_key,
    status: r.status as CompMatchStatus,
    attempt: r.attempt,
    roomCode: r.room_code,
    calledAt: ms(r.called_at),
    claimedAt: ms(r.claimed_at),
    finishedAt: ms(r.finished_at),
    result: r.winner
      ? {
          red: r.red_score,
          blue: r.blue_score,
          redFoul: r.red_foul,
          blueFoul: r.blue_foul,
          winner: r.winner as CompResult['winner'],
          source: (r.source ?? 'manual') as CompResult['source'],
        }
      : null,
    dq: (r.dq ?? []).map(Number),
    matchId: r.match_id,
    replayId: r.replay_id,
    note: r.note,
    callNote: r.call_note,
    red: side('red'),
    blue: side('blue'),
  };
}

const MATCH_SELECT = `
  select m.*,
         coalesce(json_agg(json_build_object('a', s.alliance, 'i', s.slot, 'e', s.entry_id, 's', s.surrogate))
                    filter (where s.match_id is not null), '[]'::json) as slots
    from competition_matches m
    left join competition_match_slots s on s.match_id = m.id`;

export async function listMatches(competitionId: string, query: Tx = q): Promise<MatchRow[]> {
  const rows = await query<MatchDbRow>(
    `${MATCH_SELECT} where m.competition_id = $1 group by m.id order by m.stage desc, m.number limit 2000`,
    [competitionId],
  );
  return rows.map(matchOf);
}

export async function getMatch(id: number, query: Tx = q): Promise<MatchRow | null> {
  const rows = await query<MatchDbRow>(`${MATCH_SELECT} where m.id = $1 group by m.id`, [id]);
  return rows[0] ? matchOf(rows[0]) : null;
}

export async function matchByRoomCode(code: string): Promise<MatchRow | null> {
  const rows = await q<MatchDbRow>(`${MATCH_SELECT} where m.room_code = $1 group by m.id`, [code]);
  return rows[0] ? matchOf(rows[0]) : null;
}

/**
 * Insert drawn matches and their slots in two statements (a schedule is up to a few hundred
 * matches, and a round trip per row is seconds against a remote database).
 */
export async function insertMatches(
  competitionId: string,
  stage: MatchStage,
  drawn: { round: number; number: number; series: string | null; red: CompSlot[]; blue: CompSlot[] }[],
  query: Tx = q,
): Promise<number[]> {
  if (!drawn.length) return [];
  const made = await query<{ id: string; number: number }>(
    `insert into competition_matches (competition_id, stage, round, number, series_key)
     select $1, $2, t.r, t.n, t.s from unnest($3::int[], $4::int[], $5::text[]) as t(r, n, s)
     returning id, number`,
    [competitionId, stage, drawn.map((d) => d.round), drawn.map((d) => d.number), drawn.map((d) => d.series)],
  );
  const idOf = new Map(made.map((m) => [m.number, Number(m.id)]));
  const mid: number[] = [];
  const al: string[] = [];
  const sl: number[] = [];
  const en: number[] = [];
  const su: boolean[] = [];
  for (const d of drawn) {
    const id = idOf.get(d.number);
    if (id === undefined) continue;
    for (const [a, side] of [['red', d.red], ['blue', d.blue]] as const) {
      side.forEach((s, i) => {
        mid.push(id);
        al.push(a);
        sl.push(i);
        en.push(s.entry);
        su.push(!!s.surrogate);
      });
    }
  }
  if (mid.length) {
    await query(
      `insert into competition_match_slots (match_id, alliance, slot, entry_id, surrogate)
       select * from unnest($1::bigint[], $2::text[], $3::smallint[], $4::bigint[], $5::boolean[])`,
      [mid, al, sl, en, su],
    );
  }
  return drawn.map((d) => idOf.get(d.number) ?? 0);
}

/** drop a stage's matches that have not been played or called (a re-draw) */
export async function deleteUnplayedMatches(competitionId: string, stage: MatchStage, query: Tx = q): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from competition_matches where competition_id = $1 and stage = $2 and status = 'scheduled' returning id`,
    [competitionId, stage],
  );
  return rows.length;
}

export async function deleteAllMatches(competitionId: string, stage: MatchStage, query: Tx = q): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from competition_matches where competition_id = $1 and stage = $2 returning id`,
    [competitionId, stage],
  );
  return rows.length;
}

/** replace one slot's entry (an organizer swapping a driver into a scheduled match) */
export async function setSlot(matchId: number, alliance: 'red' | 'blue', slot: number, entry: number, surrogate: boolean, query: Tx = q): Promise<void> {
  await query(
    `insert into competition_match_slots (match_id, alliance, slot, entry_id, surrogate) values ($1,$2,$3,$4,$5)
     on conflict (match_id, alliance, slot) do update set entry_id = excluded.entry_id, surrogate = excluded.surrogate`,
    [matchId, alliance, slot, entry, surrogate],
  );
}

/**
 * CALL A MATCH: a new attempt with a new room. Conditional on the match still being callable,
 * so a double-click or two referees cannot call it twice into two rooms.
 */
export async function callMatchRow(id: number, code: string, fromStatus: CompMatchStatus[]): Promise<number | null> {
  const rows = await q<{ attempt: number }>(
    `update competition_matches
        set status = 'called', attempt = attempt + 1, room_code = $2, called_at = now(),
            claimed_at = null, call_note = null
      where id = $1 and status = any($3::text[])
      returning attempt`,
    [id, code, fromStatus],
  );
  return rows[0]?.attempt ?? null;
}

/** take the call back without a result: the match goes back on the schedule */
export async function uncallMatch(id: number, attempt: number | null, note: string | null): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `update competition_matches set status = 'scheduled', claimed_at = null, call_note = $3
      where id = $1 and status = 'called' and ($2::int is null or attempt = $2)
      returning id`,
    [id, attempt, note],
  );
  return rows.length > 0;
}

/**
 * THE FIRST JOIN CLAIMS THE CALL, EXACTLY ONCE — the competition twin of `takePendingMatch`.
 * The row stays (it is the match); `claimed_at` is what makes a second room under the same code
 * impossible. A code that matches nothing claimable answers null and the join is refused.
 */
export async function claimRoom(code: string): Promise<{ id: number; attempt: number; competitionId: string } | null> {
  const rows = await q<{ id: string; attempt: number; competition_id: string }>(
    `update competition_matches set claimed_at = now()
      where room_code = $1 and status = 'called' and claimed_at is null
      returning id, attempt, competition_id`,
    [code],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), attempt: r.attempt, competitionId: r.competition_id } : null;
}

/** give a claim back (the room could not be built from it), so the next join can take it */
export async function unclaimRoom(id: number, attempt: number): Promise<void> {
  await q(`update competition_matches set claimed_at = null where id = $1 and attempt = $2 and status = 'called'`, [id, attempt]);
}

/**
 * Write a result. `attempt` (when given) makes a PLAYED result conditional on the call it came
 * from still being the current one: a room from a call the referee has since replaced finishes
 * into nothing.
 */
export async function writeResult(
  id: number,
  r: CompResult & { matchId?: string | null; replayId?: string | null; note?: string | null },
  opts: { attempt?: number; fromStatus?: CompMatchStatus[] } = {},
  query: Tx = q,
): Promise<boolean> {
  const params: unknown[] = [
    id, r.red, r.blue, r.redFoul, r.blueFoul, r.winner, r.source,
    r.matchId ?? null, r.replayId ?? null,
  ];
  let cond = '';
  if (opts.attempt !== undefined) {
    params.push(opts.attempt);
    cond += ` and attempt = $${params.length}`;
  }
  if (opts.fromStatus) {
    params.push(opts.fromStatus);
    cond += ` and status = any($${params.length}::text[])`;
  }
  let noteSet = '';
  if (r.note !== undefined) {
    params.push(r.note);
    noteSet = `, note = $${params.length}`;
  }
  const rows = await query<{ id: string }>(
    `update competition_matches
        set status = 'done', red_score = $2, blue_score = $3, red_foul = $4, blue_foul = $5,
            winner = $6, source = $7,
            match_id = coalesce($8::uuid, match_id), replay_id = coalesce($9::uuid, replay_id),
            finished_at = now(), call_note = null${noteSet}
      where id = $1${cond}
      returning id`,
    params,
  );
  return rows.length > 0;
}

/** back to the schedule with no result (a referee resetting a match). The archived match and its
 *  replay go with the result: a replay of the game that no longer counts must not sit beside the
 *  one that will. The `matches` row and the replay themselves stay in the archive. */
export async function clearResult(id: number, note: string | null): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `update competition_matches
        set status = 'scheduled', red_score = null, blue_score = null, red_foul = 0, blue_foul = 0,
            winner = null, source = null, finished_at = null, claimed_at = null, dq = '{}', note = $2,
            match_id = null, replay_id = null
      where id = $1 returning id`,
    [id, note],
  );
  return rows.length > 0;
}

export async function setMatchStatus(id: number, status: CompMatchStatus, note?: string | null): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `update competition_matches set status = $2${note !== undefined ? ', note = $3' : ''} where id = $1 returning id`,
    note !== undefined ? [id, status, note] : [id, status],
  );
  return rows.length > 0;
}

export async function setMatchDq(id: number, dq: number[]): Promise<boolean> {
  const rows = await q<{ id: string }>(`update competition_matches set dq = $2::bigint[] where id = $1 returning id`, [id, dq]);
  return rows.length > 0;
}

export async function setCallNote(id: number, attempt: number, note: string): Promise<void> {
  await q(`update competition_matches set call_note = $3 where id = $1 and attempt = $2`, [id, attempt, note]);
}

/**
 * Users already standing in a CALLED match anywhere (any competition), other than `exceptMatch`.
 * A driver cannot be in two rooms at once, and the second call would make a no-show of them.
 */
export async function usersInCalledMatches(userIds: string[], exceptMatch: number): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await q<{ u: string }>(
    `select distinct u from (
       select e.user_id as u from competition_matches m
         join competition_match_slots s on s.match_id = m.id
         join competition_entries e on e.id = s.entry_id
        where m.status = 'called' and m.id <> $2
       union all
       select e.partner_id as u from competition_matches m
         join competition_match_slots s on s.match_id = m.id
         join competition_entries e on e.id = s.entry_id
        where m.status = 'called' and m.id <> $2
     ) x where u = any($1::text[])`,
    [userIds, exceptMatch],
  );
  return new Set(rows.map((r) => r.u));
}

// ------------------------------------------------------------------------ series

export async function insertSeries(competitionId: string, specs: SeriesSpec[], query: Tx = q): Promise<void> {
  if (!specs.length) return;
  await query(
    `insert into competition_series (competition_id, key, spec)
     select $1, t.k, t.s::jsonb from unnest($2::text[], $3::text[]) as t(k, s)`,
    [competitionId, specs.map((s) => s.key), specs.map((s) => JSON.stringify(s))],
  );
}

export async function listSeries(competitionId: string, query: Tx = q): Promise<SeriesSpec[]> {
  const rows = await query<{ spec: SeriesSpec }>(
    `select spec from competition_series where competition_id = $1 limit 200`,
    [competitionId],
  );
  return rows.map((r) => r.spec);
}

export async function deleteSeries(competitionId: string, query: Tx = q): Promise<void> {
  await query(`delete from competition_series where competition_id = $1`, [competitionId]);
}

// --------------------------------------------------------------------------- log

export interface LogRow {
  id: number;
  at: number;
  actor: string;
  kind: string;
  data: Record<string, unknown>;
  public: boolean;
}

export async function addLog(
  competitionId: string,
  actor: string,
  kind: string,
  data: Record<string, unknown> = {},
  isPublic = true,
  query: Tx = q,
): Promise<void> {
  await query(
    `insert into competition_log (competition_id, actor, kind, data, public) values ($1,$2,$3,$4::jsonb,$5)`,
    [competitionId, actor, kind, JSON.stringify(data), isPublic],
  );
}

export async function listLog(competitionId: string, withPrivate: boolean, limit = 60): Promise<LogRow[]> {
  const rows = await q<{ id: string; at: string; actor: string; kind: string; data: Record<string, unknown>; public: boolean }>(
    `select id, at, actor, kind, data, public from competition_log
      where competition_id = $1 ${withPrivate ? '' : 'and public'}
      order by at desc, id desc limit $2`,
    [competitionId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({ id: Number(r.id), at: msReq(r.at), actor: r.actor, kind: r.kind, data: r.data ?? {}, public: r.public }));
}

// -------------------------------------------------------------------- per player

export interface MyEntryRow {
  competitionId: string;
  slug: string;
  name: string;
  game: GameId;
  status: CompStatus;
  settings: unknown;
  checkinOpensAt: number | null;
  entryId: number;
  entryStatus: EntryStatus;
  checkedInAt: number | null;
}

/** every competition a player is in that is not over: the call bar's one read */
export async function myOpenEntries(userId: string): Promise<MyEntryRow[]> {
  const rows = await q<{
    id: string; slug: string; name: string; game: string; status: string; settings: unknown;
    checkin_opens_at: string | null; entry_id: string; entry_status: string; checked_in_at: string | null;
  }>(
    `select c.id, c.slug, c.name, c.game, c.status, c.settings, c.checkin_opens_at,
            e.id as entry_id, e.status as entry_status, e.checked_in_at
       from competition_entries e join competitions c on c.id = e.competition_id
      where (e.user_id = $1 or e.partner_id = $1)
        and e.status in ('registered','waitlist','pending')
        and c.status in ('published','qualification','selection','playoffs')
      order by c.starts_at nulls last limit 20`,
    [userId],
  );
  return rows.map((r) => ({
    competitionId: r.id,
    slug: r.slug,
    name: r.name,
    game: r.game as GameId,
    status: r.status as CompStatus,
    settings: r.settings,
    checkinOpensAt: ms(r.checkin_opens_at),
    entryId: Number(r.entry_id),
    entryStatus: r.entry_status as EntryStatus,
    checkedInAt: ms(r.checked_in_at),
  }));
}

/** the matches of one entry that are called or still to play, in order */
export async function entryOpenMatches(entryId: number): Promise<(MatchRow & { ahead: number })[]> {
  const rows = await q<MatchDbRow & { ahead: string }>(
    `${MATCH_SELECT}
      where m.id in (select s2.match_id from competition_match_slots s2 where s2.entry_id = $1)
        and m.status in ('scheduled','called')
      group by m.id
      order by m.stage desc, m.number
      limit 20`,
    [entryId],
  );
  // how many unplayed matches of the same stage come before each one
  const out: (MatchRow & { ahead: number })[] = [];
  for (const r of rows) {
    const m = matchOf(r);
    const ahead = await q<{ n: string }>(
      `select count(*) as n from competition_matches
        where competition_id = $1 and stage = $2 and status = 'scheduled' and number < $3`,
      [m.competitionId, m.stage, m.number],
    );
    out.push({ ...m, ahead: Number(ahead[0]?.n ?? 0) });
    if (out.length >= 2) break;
  }
  return out;
}

/** a player's finished competitions and how they placed, for the profile */
export async function placementsOf(userId: string, limit = 20): Promise<{ slug: string; name: string; game: GameId; place: number | null; entrants: number; completedAt: number | null; official: boolean }[]> {
  const rows = await q<{ slug: string; name: string; game: string; placement: number | null; entrants: string; completed_at: string | null; official: boolean }>(
    `select c.slug, c.name, c.game, e.placement, c.official, c.completed_at,
            (select count(*) from competition_entries x where x.competition_id = c.id and x.status in ('registered','disqualified')) as entrants
       from competition_entries e join competitions c on c.id = e.competition_id
      where (e.user_id = $1 or e.partner_id = $1) and c.status = 'completed' and c.visibility = 'public'
        and e.status in ('registered','disqualified')
      order by c.completed_at desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map((r) => ({
    slug: r.slug, name: r.name, game: r.game as GameId, place: r.placement,
    entrants: Number(r.entrants), completedAt: ms(r.completed_at), official: r.official,
  }));
}
