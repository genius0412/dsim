/**
 * RATING RECALCULATION — re-rate every ranked match of one game's current act, in order, under
 * the rules ranked rates under now (`RATING_RULES`), and rewrite the boards, the season
 * snapshots and every match's before/after to match. Owner-requested 2026-10-03, for BIOBUZZ
 * Act 2, after a 5-0 player topped the 1v1 board at 1685 over players with 30 games.
 *
 * Glicko-2 is sequential: one match's result is the next one's starting point, for everyone in
 * it. So there is no re-rating a single match; it is the whole act or nothing.
 *
 * TWO REPLAYS OF THE SAME LOG, and the second only runs if the first is exact:
 *
 *  1. AS RATED. Every match under the rule set that rated it (`ruleSetAt`: the 0058 stamp, else
 *     dated), every behaviour charge and refund at its time, from the score it was rated on. It must
 *     reproduce every stored before/after and every stored board. If it does not, something
 *     moved a rating that this log does not contain, and re-rating would silently lose it, so
 *     the recalculation REFUSES and says where. Two things the stored rows do not say are
 *     inferred here and only here: a rated challenge (a closed party takes no margin) and,
 *     for a 2v2 before 0058 stored absence, how much of a loss the room forgave.
 *  2. UNDER `RATING_RULES`, from the CORRECTED scores, with what (1) inferred. A refund is not
 *     replayed for a corrected match: it gave back what the wrong score cost, and the replay
 *     uses the right score. Games counts cannot change; the run asserts that.
 *
 * APPLYING is one transaction that first takes SHARE ROW EXCLUSIVE on the three rating tables:
 * nothing can write a rating while it runs, and it reads the log only once it holds the lock,
 * so every match finished before that instant is in it. A match that finishes during the run
 * waits on the lock and then rates on top of the new numbers. The overwritten values go into
 * `rating_recalcs.backup`, and each player whose rating moved is sent a notice in the same
 * transaction.
 */
import { RATING_FLOOR } from '../src/config';
import type { Alliance, GameId } from '../src/types';
import { tx, type Tx } from './db/pool';
import { addNotices, actFor, type NewNotice } from './db/repo';
import { computeGlicko, ruleSetAt, RATING_RULES, type EloParticipant, type Glicko, type RatingRules } from './ranked';

type Mode = '1v1' | '2v2';
const DAY_MS = 86_400_000;

interface MatchRow {
  id: string;
  mode: Mode;
  season: number;
  at: number;
  rules: string | null;
}
interface PartRow {
  matchId: string;
  userId: string;
  alliance: Alliance;
  score: number;
  before: number;
  after: number;
  premade: boolean | null;
  away: number | null;
  early: boolean | null;
}
interface Board {
  rating: number;
  rd: number;
  vol: number;
  games: number;
  /** ms of the last write that set `updated_at` (drives idle days) */
  updatedAt: number | null;
}
type Ev =
  | {
      kind: 'match';
      at: number;
      m: MatchRow;
      parts: PartRow[];
      /** the score it was last RATED on: at play time, or at the last applied recalculation */
      rated: { red: number; blue: number };
      /** the score it says now */
      corrected: { red: number; blue: number };
      hasCorrection: boolean;
    }
  | { kind: 'charge'; at: number; userId: string; mode: Mode; amount: number }
  | {
      kind: 'refund';
      at: number;
      userId: string;
      mode: Mode;
      points: number;
      matchId: string;
      /** a recalculation since re-rated its corrected match, which is what the refund was for */
      absorbed: boolean;
    };

export interface RecalcLog {
  game: string;
  act: number;
  seasons: number[];
  events: Ev[];
  boards: Map<string, Board & { userId: string; mode: Mode }>;
  history: Map<string, { userId: string; mode: Mode; season: number; rating: number; rd: number; vol: number; games: number }>;
}

const bkey = (u: string, m: Mode): string => `${m}|${u}`;
const hkey = (u: string, m: Mode, s: number): string => `${m}|${s}|${u}`;
const pkey = (matchId: string, userId: string): string => `${matchId}|${userId}`;
const NEW_BOARD: Readonly<Board> = { rating: 1000, rd: 350, vol: 0.06, games: 0, updatedAt: null };

// ---- reading the log ----------------------------------------------------------------------

/** everything the two replays need, read through `query` (inside the caller's transaction) */
export async function readLog(query: Tx, game: string, act: number): Promise<RecalcLog> {
  const seasons = (await query<{ bv: number; started: Date }>(
    `select balance_version as bv, started_at as started from seasons where game = $1 and act = $2 order by balance_version`,
    [game, act],
  )).map((r) => ({ bv: Number(r.bv), started: new Date(r.started).getTime() }));
  const bvs = seasons.map((s) => s.bv);
  const actStart = seasons.length ? Math.min(...seasons.map((s) => s.started)) : 0;
  const matches = (await query<{ id: string; mode: Mode; bv: number; at: Date; rules: string | null }>(
    `select id, mode, balance_version as bv, created_at as at, rating_rules as rules from matches
      where game = $1 and ranked and balance_version = any($2::int[])
      order by created_at, id`,
    [game, bvs],
  )).map((r): MatchRow => ({ id: String(r.id), mode: r.mode, season: Number(r.bv), at: new Date(r.at).getTime(), rules: r.rules }));
  const ids = matches.map((m) => m.id);
  const parts = (await query<{
    match_id: string; user_id: string; alliance: Alliance; score: number; rating_before: number | null;
    rating_after: number | null; premade: boolean | null; away: number | null; early: boolean | null;
  }>(
    `select match_id, user_id, alliance, score, rating_before, rating_after, premade, away, early
       from match_participants where match_id = any($1::uuid[])`,
    [ids],
  )).map((r): PartRow => ({
    matchId: String(r.match_id), userId: r.user_id, alliance: r.alliance, score: Number(r.score),
    before: Number(r.rating_before), after: Number(r.rating_after), premade: r.premade,
    away: r.away == null ? null : Number(r.away), early: r.early,
  }));
  // A MATCH WAS RATED ON THE SCORE IT HAD WHEN IT WAS LAST RATED: when it was played, or when a
  // recalculation last re-rated the act. Corrections are replayed up to that moment.
  const lastRecalc = (await query<{ at: Date | null }>(
    `select max(applied_at) as at from rating_recalcs where game = $1 and act = $2`,
    [game, act],
  ))[0]?.at;
  const recalcAt = lastRecalc ? new Date(lastRecalc).getTime() : null;
  const corrections = new Map<string, { at: number; before: { red: number; blue: number }; after: { red: number; blue: number } }[]>();
  for (const r of await query<{ match_id: string; at: Date; rb: number; bb: number; ra: number; ba: number }>(
    `select match_id, at, red_before as rb, blue_before as bb, red_after as ra, blue_after as ba
       from match_score_corrections where match_id = any($1::uuid[]) order by match_id, at, id`,
    [ids],
  )) {
    const a = corrections.get(String(r.match_id)) ?? [];
    a.push({
      at: new Date(r.at).getTime(),
      before: { red: Number(r.rb), blue: Number(r.bb) },
      after: { red: Number(r.ra), blue: Number(r.ba) },
    });
    corrections.set(String(r.match_id), a);
  }
  const scoreAt = (matchId: string, now: { red: number; blue: number }, t: number): { red: number; blue: number } => {
    const cs = corrections.get(matchId);
    if (!cs?.length) return now;
    let sc = cs[0].before;
    for (const c of cs) if (c.at <= t) sc = c.after;
    return sc;
  };
  const refunds = await query<{ match_id: string; user_id: string; points: number; at: Date }>(
    `select match_id, user_id, points, at from rating_refunds where match_id = any($1::uuid[])`,
    [ids],
  );
  // a charge on this game's boards since the act began; one with no board (a moderator's, which
  // lands on whatever the player last played) is not attributable and is left to validation
  const charges = await query<{ user_id: string; mode: Mode; amount: number; at: Date }>(
    `select user_id, mode, rating_charge as amount, at from standing_events
      where rating_charge <> 0 and game = $1 and mode in ('1v1', '2v2') and at >= $2`,
    [game, new Date(actStart)],
  );
  const boards = new Map<string, Board & { userId: string; mode: Mode }>();
  for (const r of await query<{ user_id: string; mode: Mode; rating: number; rd: number; vol: number; games: number; updated_at: Date }>(
    `select user_id, mode, rating, rd, vol, games, updated_at from elo_ratings where game = $1 and act = $2`,
    [game, act],
  )) {
    boards.set(bkey(r.user_id, r.mode), {
      userId: r.user_id, mode: r.mode, rating: Number(r.rating), rd: Number(r.rd), vol: Number(r.vol),
      games: Number(r.games), updatedAt: new Date(r.updated_at).getTime(),
    });
  }
  const history = new Map<string, { userId: string; mode: Mode; season: number; rating: number; rd: number; vol: number; games: number }>();
  for (const r of await query<{ user_id: string; mode: Mode; bv: number; rating: number; rd: number; vol: number; games: number }>(
    `select user_id, mode, balance_version as bv, rating, rd, vol, games from elo_history
      where game = $1 and balance_version = any($2::int[])`,
    [game, bvs],
  )) {
    history.set(hkey(r.user_id, r.mode, Number(r.bv)), {
      userId: r.user_id, mode: r.mode, season: Number(r.bv), rating: Number(r.rating), rd: Number(r.rd),
      vol: Number(r.vol), games: Number(r.games),
    });
  }

  const byMatch = new Map<string, PartRow[]>();
  for (const p of parts) {
    const a = byMatch.get(p.matchId) ?? [];
    a.push(p);
    byMatch.set(p.matchId, a);
  }
  const events: Ev[] = [];
  for (const m of matches) {
    const ps = byMatch.get(m.id) ?? [];
    const corrected = {
      red: ps.find((p) => p.alliance === 'red')?.score ?? 0,
      blue: ps.find((p) => p.alliance === 'blue')?.score ?? 0,
    };
    const ratedAt = recalcAt === null ? m.at : Math.max(m.at, recalcAt);
    events.push({
      kind: 'match', at: m.at, m, parts: ps, rated: scoreAt(m.id, corrected, ratedAt), corrected,
      hasCorrection: corrections.has(m.id),
    });
  }
  const modeOf = new Map(matches.map((m) => [m.id, m.mode]));
  for (const r of refunds) {
    const id = String(r.match_id);
    const mode = modeOf.get(id);
    if (!mode) continue;
    const at = new Date(r.at).getTime();
    // a refund for a correction that a later recalculation re-rated was absorbed by it
    const absorbed = recalcAt !== null && at <= recalcAt && (corrections.get(id) ?? []).some((c) => c.at <= recalcAt);
    events.push({ kind: 'refund', at, userId: r.user_id, mode, points: Number(r.points), matchId: id, absorbed });
  }
  for (const c of charges) {
    events.push({ kind: 'charge', at: new Date(c.at).getTime(), userId: c.user_id, mode: c.mode, amount: Number(c.amount) });
  }
  // ON A TIE A CHARGE GOES FIRST: a match's row is stamped when its transaction starts and its
  // ratings are read after that, so a charge stamped the same instant had already landed. A wrong
  // guess cannot slip through: replay 1 would not reproduce the next stored "before".
  const rank = { charge: 0, match: 1, refund: 2 } as const;
  events.sort((a, b) => a.at - b.at || rank[a.kind] - rank[b.kind]);
  return { game, act, seasons: bvs, events, boards, history };
}

// ---- the replays ----------------------------------------------------------------------------

/** what replay 1 had to infer about a match that its stored rows do not say */
interface Adjust {
  /** a rated challenge: one party token on both alliances, so no margin multiplier */
  closed: Set<string>;
  /** per participant: the share of their computed change the room applied (a forgiven loss) */
  factor: Map<string, number>;
  /** per participant: absent from the start, so the room voided the 2v2 for everyone else */
  early: Set<string>;
}

interface ReplayOut {
  boards: Map<string, Board & { userId: string; mode: Mode }>;
  history: Map<string, { userId: string; mode: Mode; season: number; rating: number; rd: number; vol: number; games: number }>;
  parts: Map<string, { before: number; after: number }>;
}

function participants(
  e: Extract<Ev, { kind: 'match' }>,
  boards: Map<string, Board>,
  closed: boolean,
  early: Set<string> = new Set(),
): EloParticipant[] {
  return e.parts.map((p) => {
    const b = boards.get(bkey(p.userId, e.m.mode)) ?? NEW_BOARD;
    return {
      userId: p.userId,
      alliance: p.alliance,
      rating: { rating: b.rating, rd: b.rd, vol: b.vol },
      games: b.games,
      idleDays: b.updatedAt === null ? 0 : Math.max(0, Math.floor((e.at - b.updatedAt) / DAY_MS)),
      // a premade (0056) is one token per alliance; a closed challenge one token for the match
      party: closed ? `${e.m.id}` : p.premade ? `${e.m.id}:${p.alliance}` : undefined,
      away: p.away ?? undefined,
      early: early.has(pkey(e.m.id, p.userId)) || (p.early ?? undefined),
    };
  });
}

function applyCharge(boards: Map<string, Board & { userId: string; mode: Mode }>, userId: string, mode: Mode, amount: number, at: number): void {
  const k = bkey(userId, mode);
  const b = boards.get(k) ?? { ...NEW_BOARD, userId, mode };
  const r = Math.min(b.rating, Math.max(RATING_FLOOR, b.rating - amount));
  boards.set(k, { ...b, rating: r, updatedAt: r !== b.rating ? at : b.updatedAt });
}

function write(
  out: ReplayOut,
  e: Extract<Ev, { kind: 'match' }>,
  p: PartRow,
  state: Glicko,
  before: number,
  after: number,
  counted: boolean,
): void {
  const k = bkey(p.userId, e.m.mode);
  const b = out.boards.get(k) ?? { ...NEW_BOARD, userId: p.userId, mode: e.m.mode };
  out.parts.set(pkey(e.m.id, p.userId), { before, after });
  if (!counted) return; // voided for this player: nothing written to the board
  const nb = { ...b, rating: after, rd: Math.fround(state.rd), vol: Math.fround(state.vol), games: b.games + 1, updatedAt: e.at };
  out.boards.set(k, nb);
  out.history.set(hkey(p.userId, e.m.mode, e.m.season), {
    userId: p.userId, mode: e.m.mode, season: e.m.season, rating: nb.rating, rd: nb.rd, vol: nb.vol, games: nb.games,
  });
}

export interface Validation {
  ok: boolean;
  matches: number;
  results: number;
  /** stored results the as-rated replay reproduced */
  reproduced: number;
  closedChallenges: number;
  absenceAdjusted: number;
  /** pre-0058 2v2s found to have been voided for a partner absent from the start */
  voidedInferred: number;
  /** stored boards no event in the log touches, left exactly as they are (`mode|userId`) */
  kept: string[];
  /** how many, and the first 50 */
  problemCount: number;
  problems: string[];
}

/** REPLAY 1: as rated. Returns what it had to infer, and whether it reproduced everything. */
export function replayAsRated(log: RecalcLog): { validation: Validation; adjust: Adjust } {
  const out: ReplayOut = { boards: new Map(), history: new Map(), parts: new Map() };
  const adjust: Adjust = { closed: new Set(), factor: new Map(), early: new Set() };
  const problems: string[] = [];
  let matches = 0, results = 0, reproduced = 0, absence = 0, voids = 0;
  for (const e of log.events) {
    if (e.kind === 'charge') {
      applyCharge(out.boards, e.userId, e.mode, e.amount, e.at);
      continue;
    }
    if (e.kind === 'refund') {
      if (e.absorbed) continue;
      const k = bkey(e.userId, e.mode);
      const b = out.boards.get(k);
      if (b) out.boards.set(k, { ...b, rating: b.rating + e.points });
      continue;
    }
    matches++;
    const rules = ruleSetAt(e.m.rules, e.at);
    const fits = (ups: ReturnType<typeof computeGlicko>) =>
      e.parts.every((p) => Math.round(ups.find((u) => u.userId === p.userId)!.state.rating) === p.after);
    let ups = computeGlicko(participants(e, out.boards, false), e.rated, { mode: e.m.mode, rules });
    if (!fits(ups) && rules.model === 'team') {
      const closed = computeGlicko(participants(e, out.boards, true), e.rated, { mode: e.m.mode, rules });
      if (fits(closed)) {
        adjust.closed.add(e.m.id);
        ups = closed;
      }
    }
    // A VOIDED 2v2 from before 0058 stored no absence: everyone who was there shows no change,
    // and the one absentee a loss. Name that absentee early and see whether the rules agree.
    const unstored = e.parts.every((p) => p.away === null && p.early === null);
    if (!fits(ups) && rules.model === 'team' && e.m.mode === '2v2' && unstored) {
      const movers = e.parts.filter((p) => p.after !== p.before);
      if (movers.length <= 1) {
        const named = new Set(movers.map((p) => pkey(e.m.id, p.userId)));
        const trial = computeGlicko(participants(e, out.boards, false, named), e.rated, { mode: e.m.mode, rules });
        if (fits(trial)) {
          for (const k of named) adjust.early.add(k);
          voids++;
          ups = trial;
        }
      }
    }
    for (const p of e.parts) {
      results++;
      const u = ups.find((x) => x.userId === p.userId)!;
      const b = out.boards.get(bkey(p.userId, e.m.mode)) ?? NEW_BOARD;
      if (b.rating !== p.before) {
        problems.push(`${new Date(e.at).toISOString()} ${e.m.mode} ${p.userId}: stored before ${p.before}, replay ${b.rating}`);
        continue;
      }
      const computed = Math.round(u.state.rating);
      if (computed === p.after) {
        reproduced++;
        write(out, e, p, u.state, p.before, p.after, !u.voided);
        continue;
      }
      // NOT REPRODUCED. Before 0058 a 2v2 room's absence ruling is not stored; it is the one
      // thing that may explain a 2v2 result the rules alone do not: a forgiven share of a
      // teammate's loss or of a win over a short-handed alliance, never a bigger change than the
      // rules give. It still counts as a game (a void is handled above).
      const raw = u.state.rating - p.before;
      const got = p.after - p.before;
      const f = raw !== 0 ? got / raw : NaN;
      if (e.m.mode === '2v2' && unstored && Number.isFinite(f) && f >= -1e-9 && f <= 1 + 1e-9) {
        absence++;
        adjust.factor.set(pkey(e.m.id, p.userId), Math.max(0, Math.min(1, f)));
        write(out, e, p, u.state, p.before, p.after, true);
        continue;
      }
      problems.push(`${new Date(e.at).toISOString()} ${e.m.mode} ${p.userId}: stored ${p.before}->${p.after}, replay ${p.before}->${computed} (${rules.id})`);
    }
  }
  // the boards it ends on must be the boards that are stored, row for row — except a board NO
  // event in the log touches. Nothing here can re-derive it, and since it met nobody in the log,
  // re-rating everyone else cannot move it either: it is kept as stored, and counted.
  const kept: string[] = [];
  for (const [k, s] of log.boards) {
    const r = out.boards.get(k);
    if (!r) {
      kept.push(k);
      continue;
    }
    if (!r || r.rating !== s.rating || r.games !== s.games || Math.abs(r.rd - s.rd) > 0.5) {
      problems.push(`board ${k}: stored ${s.rating}/${s.games}g/rd ${s.rd.toFixed(1)}, replay ${r ? `${r.rating}/${r.games}g/rd ${r.rd.toFixed(1)}` : 'none'}`);
    }
  }
  for (const k of out.boards.keys()) if (!log.boards.has(k)) problems.push(`board ${k}: replayed but not stored`);
  // ...and so must the season snapshots
  const keptUsers = new Set(kept);
  for (const [k, s] of log.history) {
    if (keptUsers.has(`${s.mode}|${s.userId}`) && !out.history.has(k)) continue;
    const r = out.history.get(k);
    if (!r || r.rating !== s.rating || r.games !== s.games) {
      problems.push(`season snapshot ${k}: stored ${s.rating}/${s.games}g, replay ${r ? `${r.rating}/${r.games}g` : 'none'}`);
    }
  }
  return {
    validation: {
      ok: problems.length === 0,
      matches, results, reproduced,
      closedChallenges: adjust.closed.size,
      absenceAdjusted: absence,
      voidedInferred: voids,
      kept,
      problemCount: problems.length,
      problems: problems.slice(0, 50),
    },
    adjust,
  };
}

/** REPLAY 2: every match under `rules`, from the corrected scores, with what replay 1 inferred */
export function replayUnder(log: RecalcLog, rules: RatingRules, adjust: Adjust): ReplayOut {
  const out: ReplayOut = { boards: new Map(), history: new Map(), parts: new Map() };
  const corrected = new Set(log.events.filter((e) => e.kind === 'match' && e.hasCorrection).map((e) => (e as Extract<Ev, { kind: 'match' }>).m.id));
  for (const e of log.events) {
    if (e.kind === 'charge') {
      applyCharge(out.boards, e.userId, e.mode, e.amount, e.at);
      continue;
    }
    if (e.kind === 'refund') {
      if (corrected.has(e.matchId)) continue; // the replay rates the corrected score itself
      const k = bkey(e.userId, e.mode);
      const b = out.boards.get(k);
      if (b) out.boards.set(k, { ...b, rating: b.rating + e.points });
      continue;
    }
    const ups = computeGlicko(participants(e, out.boards, adjust.closed.has(e.m.id), adjust.early), e.corrected, { mode: e.m.mode, rules });
    for (const p of e.parts) {
      const u = ups.find((x) => x.userId === p.userId)!;
      const before = (out.boards.get(bkey(p.userId, e.m.mode)) ?? NEW_BOARD).rating;
      const f = adjust.factor.get(pkey(e.m.id, p.userId));
      if (u.voided) {
        write(out, e, p, u.state, before, before, false);
        continue;
      }
      const after = Math.round(f === undefined ? u.state.rating : before + f * (u.state.rating - before));
      write(out, e, p, u.state, before, after, true);
    }
  }
  return out;
}

// ---- the run ----------------------------------------------------------------------------------

export interface RecalcRow {
  userId: string;
  mode: Mode;
  games: number;
  before: number;
  after: number;
}
export interface RecalcResult {
  game: string;
  act: number;
  rules: string;
  applied: boolean;
  validation: Validation;
  /** every board row, old → new */
  rows: RecalcRow[];
  changed: { boards: number; history: number; participants: number };
  notices: number;
}

/**
 * Plan (and, with `apply`, perform) the recalculation of `game`'s current act.
 *
 * A dry run reads one consistent snapshot (REPEATABLE READ, READ ONLY) and writes nothing. An
 * applied run refuses unless the as-rated replay reproduced every stored rating.
 */
export async function recalcAct(opts: {
  game: GameId;
  apply: boolean;
  adminId: string;
  rules?: RatingRules;
}): Promise<RecalcResult> {
  const rules = opts.rules ?? RATING_RULES;
  const act = await actFor(opts.game);
  return tx(async (query) => {
    if (opts.apply) {
      await query(`set local lock_timeout = '15s'`);
      await query(`select pg_advisory_xact_lock(hashtext('rating-recalc'))`);
      // nothing writes a rating, a season snapshot or a match result until this commits
      await query(`lock table elo_ratings, elo_history, match_participants in share row exclusive mode`);
    } else {
      await query(`set transaction isolation level repeatable read read only`);
    }
    const log = await readLog(query, opts.game, act);
    const { validation, adjust } = replayAsRated(log);
    const next = replayUnder(log, rules, adjust);

    const rows: RecalcRow[] = [];
    for (const [k, s] of log.boards) {
      const n = next.boards.get(k);
      if (!n) continue; // an untouched lock seed (see replayAsRated)
      rows.push({ userId: s.userId, mode: s.mode, games: s.games, before: s.rating, after: n.rating });
      if (n.games !== s.games) {
        validation.ok = false;
        validation.problemCount++;
        validation.problems.push(`board ${k}: games ${s.games} would become ${n.games}`);
      }
    }
    rows.sort((a, b) => (a.mode === b.mode ? b.after - a.after : a.mode < b.mode ? -1 : 1));
    const boardsChanged = [...log.boards].filter(([k, s]) => {
      const n = next.boards.get(k);
      return n && (n.rating !== s.rating || Math.abs(n.rd - s.rd) > 1e-3 || Math.abs(n.vol - s.vol) > 1e-6);
    });
    const historyChanged = [...next.history].filter(([k, n]) => {
      const s = log.history.get(k);
      return !s || s.rating !== n.rating || Math.abs(s.rd - n.rd) > 1e-3 || s.games !== n.games;
    });
    const partsChanged: { matchId: string; userId: string; before: number; after: number; was: [number, number] }[] = [];
    for (const e of log.events) {
      if (e.kind !== 'match') continue;
      for (const p of e.parts) {
        const n = next.parts.get(pkey(e.m.id, p.userId))!;
        if (n.before !== p.before || n.after !== p.after) {
          partsChanged.push({ matchId: e.m.id, userId: p.userId, before: n.before, after: n.after, was: [p.before, p.after] });
        }
      }
    }
    const result: RecalcResult = {
      game: opts.game, act, rules: rules.id, applied: false, validation, rows,
      changed: { boards: boardsChanged.length, history: historyChanged.length, participants: partsChanged.length },
      notices: 0,
    };
    if (!opts.apply || !validation.ok) return result;

    // ---- APPLY -------------------------------------------------------------------------------
    const backup = {
      boards: boardsChanged.map(([, s]) => ({ userId: s.userId, mode: s.mode, rating: s.rating, rd: s.rd, vol: s.vol })),
      history: historyChanged.map(([k]) => log.history.get(k) ?? { key: k, absent: true }),
      participants: partsChanged.map((p) => ({ matchId: p.matchId, userId: p.userId, before: p.was[0], after: p.was[1] })),
      // the stamps it is about to overwrite
      stamps: log.events.filter((e) => e.kind === 'match').map((e) => {
        const m = (e as Extract<Ev, { kind: 'match' }>).m;
        return { matchId: m.id, rules: m.rules };
      }),
    };
    if (boardsChanged.length) {
      const ns = boardsChanged.map(([k]) => next.boards.get(k)!);
      await query(
        `update elo_ratings e set rating = t.r, rd = t.rd, vol = t.v
           from unnest($1::text[], $2::text[], $3::int[], $4::real[], $5::real[]) as t(u, m, r, rd, v)
          where e.user_id = t.u and e.mode = t.m and e.game = $6 and e.act = $7`,
        [ns.map((n) => n.userId), ns.map((n) => n.mode), ns.map((n) => Math.round(n.rating)), ns.map((n) => n.rd), ns.map((n) => n.vol), opts.game, act],
      );
    }
    if (historyChanged.length) {
      const hs = historyChanged.map(([, n]) => n);
      await query(
        `insert into elo_history (user_id, mode, game, balance_version, rating, rd, vol, games)
         select t.u, t.m, $1, t.s, t.r, t.rd, t.v, t.g
           from unnest($2::text[], $3::text[], $4::int[], $5::int[], $6::real[], $7::real[], $8::int[]) as t(u, m, s, r, rd, v, g)
         on conflict (user_id, mode, game, balance_version)
           do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol, games = excluded.games`,
        [opts.game, hs.map((h) => h.userId), hs.map((h) => h.mode), hs.map((h) => h.season), hs.map((h) => Math.round(h.rating)),
          hs.map((h) => h.rd), hs.map((h) => h.vol), hs.map((h) => h.games)],
      );
    }
    if (partsChanged.length) {
      await query(
        `update match_participants mp set rating_before = t.b, rating_after = t.a
           from unnest($1::uuid[], $2::text[], $3::int[], $4::int[]) as t(mid, u, b, a)
          where mp.match_id = t.mid and mp.user_id = t.u`,
        [partsChanged.map((p) => p.matchId), partsChanged.map((p) => p.userId), partsChanged.map((p) => p.before), partsChanged.map((p) => p.after)],
      );
    }
    // every match of the act is now rated under `rules`, so that is what its stamp says: the
    // next recalculation replays it as rated from here
    const matchIds = log.events.filter((e) => e.kind === 'match').map((e) => (e as Extract<Ev, { kind: 'match' }>).m.id);
    if (matchIds.length) {
      await query(`update matches set rating_rules = $1 where id = any($2::uuid[])`, [rules.id, matchIds]);
    }
    const summary = {
      validation: { ...validation, problems: [] },
      changed: result.changed,
      top: Object.fromEntries((['1v1', '2v2'] as const).map((m) => [m, rows.filter((r) => r.mode === m).slice(0, 10)])),
    };
    await query(
      `insert into rating_recalcs (game, act, rules, admin_id, summary, backup) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [opts.game, act, rules.id, opts.adminId, JSON.stringify(summary), JSON.stringify(backup)],
    );
    const notices: NewNotice[] = rows
      .filter((r) => r.before !== r.after)
      .map((r) => ({ userId: r.userId, kind: 'rating.recalculated', game: opts.game, data: { mode: r.mode, before: r.before, after: r.after } }));
    result.notices = await addNotices(notices, query);
    result.applied = true;
    return result;
  });
}
