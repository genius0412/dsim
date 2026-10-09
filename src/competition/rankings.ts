/**
 * QUALIFICATION RANKINGS AND PLAYOFF SEEDING, derived from the matches on every read.
 *
 * Nothing here is stored: a corrected result, a late DQ or a card re-ranks the table the next time
 * it is read, and the order is a pure function of (entries, matches, ranking rules, seed) — the
 * final coin is a hash of the competition seed, not a draw, so two reads never disagree.
 *
 * The rules applied are a `ResolvedRanking` (`manual.ts` `effectiveRanking`): the game's
 * Competition Manual table (`cm`) or the organizer's points and tiebreakers (`custom`). The two
 * differ in three places, each noted where it applies: bonus RPs (`cm` only), the tiebreak order,
 * and what a disqualified match does to the averages.
 */
import type {
  Alliance,
  CardColour,
  CompEntryCore,
  CompMatchCore,
  DqReason,
  EffectiveDq,
  MatchRp,
  RankRow,
  ResolvedRanking,
  Tiebreaker,
  Winner,
} from './types';
import { MEASURE_TIEBREAKERS } from './types';
import { bonusEarned } from './manual';
import { hash32 } from './rng';

/** a match whose result the rankings read: a finished qualification match with a result */
const counts = (m: CompMatchCore): boolean => m.stage === 'qual' && m.status === 'done' && !!m.result;

/**
 * ONE ENTRY'S CARD IN ONE MATCH: the sim's and the referee's together. A red from either is red,
 * and so are two yellows (one each): two yellows to one team in a match is a red.
 */
export function colourIn(m: Pick<CompMatchCore, 'cards' | 'refCards'>, entry: number): CardColour | null {
  const a = m.cards?.[String(entry)];
  const b = m.refCards?.[String(entry)];
  if (a === 'red' || b === 'red') return 'red';
  const yellows = (a === 'yellow' ? 1 : 0) + (b === 'yellow' ? 1 : 0);
  return yellows >= 2 ? 'red' : yellows === 1 ? 'yellow' : null;
}

interface Escalation {
  /** match id → who takes nothing from it and why */
  dq: Map<number, EffectiveDq[]>;
  /** entries holding a yellow card after their last match */
  carrying: Set<number>;
}

/**
 * THE CARD AND DQ PASS (§10.6.1, Table 10-5 of the DECODE and BIOBUZZ manuals). Each entry's
 * appearances are walked in the order the matches were decided — `finishedAt`, first decided and
 * kept through corrections, then the match number; a match with no time goes last — not in
 * schedule order, because a yellow escalates in the next match PLAYED.
 *
 * A counted appearance (not a surrogate) is a DQ when the entry is in `match.dq` (`dq`), it was
 * shown a red there (`red`), or a yellow while already carrying one (`yellow2`). A surrogate
 * appearance does not count, but its card does: a red, or a yellow while carrying, disqualifies
 * the entry's most recent EARLIER counted match (`surrogate`); with none earlier, the next counted
 * one, as if the card were shown there. A `dq` on a surrogate appearance does nothing — that match
 * gives the entry nothing to take away. Any card, either kind of appearance, leaves the entry
 * carrying a yellow for the rest of qualifications.
 */
function escalate(matches: CompMatchCore[]): Escalation {
  const slots = new Map<number, { m: CompMatchCore; surrogate: boolean }[]>();
  for (const m of matches) {
    if (!counts(m)) continue;
    for (const s of [...m.red, ...m.blue]) {
      const list = slots.get(s.entry) ?? [];
      list.push({ m, surrogate: !!s.surrogate });
      slots.set(s.entry, list);
    }
  }
  const when = (m: CompMatchCore): number => (typeof m.finishedAt === 'number' && Number.isFinite(m.finishedAt) ? m.finishedAt : Infinity);
  const byMatch = new Map<number, Map<number, DqReason>>();
  const mark = (m: CompMatchCore, entry: number, why: DqReason): void => {
    const at = byMatch.get(m.id) ?? new Map<number, DqReason>();
    if (!at.has(entry)) at.set(entry, why); // one reason per entry: the first one found
    byMatch.set(m.id, at);
  };
  const carrying = new Set<number>();
  for (const [entry, list] of slots) {
    list.sort((a, b) => {
      const ta = when(a.m);
      const tb = when(b.m);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.m.number - b.m.number || a.m.id - b.m.id;
    });
    let carry = false;
    let lastCounted: CompMatchCore | null = null;
    // a surrogate card with no earlier counted match, waiting for the next one
    let deferred = false;
    for (const { m, surrogate } of list) {
      const c = colourIn(m, entry);
      const dqs = c === 'red' || (c === 'yellow' && carry);
      if (surrogate) {
        if (dqs) {
          if (lastCounted) mark(lastCounted, entry, 'surrogate');
          else deferred = true;
        }
      } else {
        if (m.dq.includes(entry)) mark(m, entry, 'dq');
        else if (c === 'red') mark(m, entry, 'red');
        else if (c === 'yellow' && carry) mark(m, entry, 'yellow2');
        else if (deferred) mark(m, entry, 'surrogate');
        deferred = false;
        lastCounted = m;
      }
      if (c) carry = true;
    }
    if (carry) carrying.add(entry);
  }
  const dq = new Map<number, EffectiveDq[]>();
  for (const [id, at] of byMatch) dq.set(id, [...at].sort((a, b) => a[0] - b[0]).map(([entry, why]) => ({ entry, why })));
  return { dq, carrying };
}

/**
 * WHO TAKES NOTHING FROM EACH MATCH, AND WHY (`escalate` above), keyed by match id. Only matches
 * with at least one DQ are in the map. Derived on read like everything else here: a card added to
 * an early match can move a DQ in a later one, and the match views must agree with the rankings.
 */
export function effectiveDq(matches: CompMatchCore[]): Map<number, EffectiveDq[]> {
  return escalate(matches).dq;
}

interface Acc {
  entry: number;
  disqualified: boolean;
  registered: boolean;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  rp: number;
  scored: number;
  dqs: number;
  sumScore: number;
  sumNoFoul: number;
  highScore: number;
  sumMargin: number;
  sumFouls: number;
  bonus: Record<string, number>;
  measure: Record<string, { sum: number; n: number }>;
}

/** the win/tie/loss points one alliance takes from a result */
const resultRp = (r: ResolvedRanking, winner: Winner, side: Alliance): number =>
  winner === 'tie' ? r.tie : winner === side ? r.win : r.loss;

/**
 * THE RANKING TABLE.
 *
 * Who is in it: entries that are `registered`, plus `withdrawn` and `disqualified` entries that
 * played at least one counted match (their results stay part of the event). Waitlisted and
 * pending entries never are.
 *
 * What counts: qualification matches that are `done` with a result, and only the slots that are
 * not surrogate appearances (the manual leaves surrogate matches out of every calculation). Each
 * counts as played, and is one of three kinds:
 *
 *   DISQUALIFIED (`effectiveDq`: a referee's or a no-show's DQ, a red card, a second yellow, a
 *   surrogate match's card): 0 RP and a loss, whatever the alliance did. The partner keeps the
 *   alliance's RP (T601). Under `cm` the match "contributes 0 to all sort criteria": it adds 0 to
 *   the score, no-foul and measure averages and stays in their denominators, so a DQ always costs
 *   the averages something. Under `custom` it is left out of every average, as every competition
 *   was ranked before the manual scheme existed. The margin and fouls-given averages leave it out
 *   under both, because a 0 there would flatter the entry (no fouls given, no margin lost).
 *
 *   FORFEIT (null scores): the result's RP only, no bonus RP, and out of every average — there is
 *   no score to average.
 *
 *   SCORED: the result's RP, plus 1 per bonus RP the alliance earned (`bonusEarned`, against the
 *   alliance's facts and the referee's rulings; `cm` only), and every average:
 *     own score  — the alliance total
 *     no-foul    — own score minus the foul points the alliance was GIVEN (red → `redFoul`),
 *                  never below 0
 *     margin     — own score minus the opponent's
 *     fouls      — the foul points it GAVE AWAY: the OPPONENT's foul field
 *     measures   — each reported measure (`AllianceFacts`), averaged over the matches that have it.
 *                  A missing key is UNKNOWN, not 0: an entry whose matches have no value for it
 *                  averages null (and sorts below every number), and DQ matches alone never make it
 *                  known.
 *
 * Order: disqualified entries last; entries that have played nothing just above them; then
 * ranking score (RP per match played) descending, the ranking's tiebreakers in order (fewest fouls
 * ascending, every other one descending, null lowest), and finally the coin `hash32(seed, entry)`,
 * higher first. Ranks are 1…n with no shared places.
 */
export function computeRankings(
  entries: CompEntryCore[],
  matches: CompMatchCore[],
  ranking: ResolvedRanking,
  seed: number,
): RankRow[] {
  const cm = ranking.scheme === 'cm';
  const esc = escalate(matches);
  const accs = new Map<number, Acc>();
  for (const e of entries) {
    if (e.status !== 'registered' && e.status !== 'withdrawn' && e.status !== 'disqualified') continue;
    accs.set(e.id, {
      entry: e.id,
      disqualified: e.status === 'disqualified',
      registered: e.status === 'registered',
      played: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      rp: 0,
      scored: 0,
      dqs: 0,
      sumScore: 0,
      sumNoFoul: 0,
      highScore: 0,
      sumMargin: 0,
      sumFouls: 0,
      bonus: Object.fromEntries(ranking.bonus.map((b) => [b.id, 0])),
      measure: Object.fromEntries(ranking.measures.map((k) => [k, { sum: 0, n: 0 }])),
    });
  }

  for (const m of matches) {
    if (!counts(m)) continue;
    const r = m.result!;
    const hasScore = r.red != null && r.blue != null;
    const out = new Set((esc.dq.get(m.id) ?? []).map((d) => d.entry));
    for (const side of ['red', 'blue'] as const) {
      const own = side === 'red' ? r.red : r.blue;
      const other = side === 'red' ? r.blue : r.red;
      const given = side === 'red' ? r.redFoul : r.blueFoul;
      const gaveAway = side === 'red' ? r.blueFoul : r.redFoul;
      const facts = m.facts?.[side];
      const earned = hasScore ? ranking.bonus.filter((b) => bonusEarned(b, facts, m.rulings?.[side]?.[b.id])) : [];
      for (const slot of m[side]) {
        if (slot.surrogate) continue;
        const a = accs.get(slot.entry);
        if (!a) continue;
        a.played++;
        if (out.has(slot.entry)) {
          a.losses++;
          a.dqs++;
          continue;
        }
        if (r.winner === 'tie') a.ties++;
        else if (r.winner === side) a.wins++;
        else a.losses++;
        a.rp += resultRp(ranking, r.winner, side);
        if (!hasScore) continue;
        a.rp += earned.length;
        for (const b of earned) a.bonus[b.id] = (a.bonus[b.id] ?? 0) + 1;
        a.scored++;
        a.sumScore += own!;
        a.sumNoFoul += Math.max(0, own! - (given || 0));
        a.highScore = a.scored === 1 ? own! : Math.max(a.highScore, own!);
        a.sumMargin += own! - other!;
        a.sumFouls += gaveAway || 0;
        for (const k of ranking.measures) {
          const v = facts?.[k];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          a.measure[k].sum += v;
          a.measure[k].n++;
        }
      }
    }
  }

  const rows: RankRow[] = [];
  const coin = new Map<number, number>();
  for (const a of accs.values()) {
    if (!a.registered && a.played === 0) continue;
    // under `cm` a DQ match is a 0 in the point averages, so it is in their denominators
    const extra = cm ? a.dqs : 0;
    const pts = (x: number): number => (a.scored + extra > 0 ? x / (a.scored + extra) : 0);
    const own = (x: number): number => (a.scored > 0 ? x / a.scored : 0);
    const avg: Record<string, number | null> = {};
    for (const k of ranking.measures) {
      const { sum, n } = a.measure[k];
      avg[k] = n > 0 ? sum / (n + extra) : null;
    }
    rows.push({
      rank: 0,
      entry: a.entry,
      played: a.played,
      wins: a.wins,
      losses: a.losses,
      ties: a.ties,
      rp: a.rp,
      rs: a.played > 0 ? a.rp / a.played : 0,
      scored: a.scored,
      avgScore: pts(a.sumScore),
      avgNoFoul: pts(a.sumNoFoul),
      highScore: a.highScore,
      avgMargin: own(a.sumMargin),
      avgFouls: own(a.sumFouls),
      disqualified: a.disqualified,
      bonus: a.bonus,
      avg,
      dqs: a.dqs,
      yellow: esc.carrying.has(a.entry),
    });
    coin.set(a.entry, hash32(seed, a.entry));
  }

  // null (unknown) sorts lowest; fewest fouls is the one where less is better
  const key = (row: RankRow, t: Tiebreaker): number => {
    const v = tbValue(row, t);
    if (v === null) return -Infinity;
    return t === 'fewestFouls' ? -v : v;
  };
  rows.sort((a, b) => {
    const dq = Number(a.disqualified) - Number(b.disqualified);
    if (dq) return dq;
    const idle = Number(a.played === 0) - Number(b.played === 0);
    if (idle) return idle;
    if (a.rs !== b.rs) return b.rs - a.rs;
    for (const t of ranking.tiebreakers) {
      const x = key(a, t);
      const y = key(b, t);
      if (x !== y) return x > y ? -1 : 1;
    }
    const ca = coin.get(a.entry)!;
    const cb = coin.get(b.entry)!;
    if (ca !== cb) return cb - ca;
    return a.entry - b.entry;
  });
  rows.forEach((row, i) => (row.rank = i + 1));
  return rows;
}

/**
 * THE VALUE A TIEBREAKER READS for one row, as a column prints it: null when a measured tiebreaker
 * has no known value (an older row, or no match reported it). Fewest fouls is the average foul
 * points given away, as is — the sort is what treats it as lower-is-better.
 */
export function tbValue(row: RankRow, t: Tiebreaker): number | null {
  const m = MEASURE_TIEBREAKERS[t];
  if (m) {
    const v = row.avg?.[m];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  switch (t) {
    case 'avgNoFoul':
      return row.avgNoFoul;
    case 'avgScore':
      return row.avgScore;
    case 'highScore':
      return row.highScore;
    case 'avgMargin':
      return row.avgMargin;
    case 'wins':
      return row.wins;
    case 'fewestFouls':
      return row.avgFouls;
    default:
      return null;
  }
}

/**
 * THE RANKING POINTS ONE QUALIFICATION MATCH GAVE: per alliance, the result's points and the bonus
 * RPs earned (none on a forfeit), and per entry what it took — the alliance total, or 0 when it was
 * disqualified in the match or it played as a surrogate. `eff` is the match's `effectiveDq` entry;
 * without it, the match's own `dq` list is used (no card escalation). Null for anything that gave
 * no ranking points: a playoff match, or one with no result.
 */
export function matchRp(m: CompMatchCore, ranking: ResolvedRanking, eff?: EffectiveDq[]): MatchRp | null {
  if (!counts(m)) return null;
  const r = m.result!;
  const hasScore = r.red != null && r.blue != null;
  const out = new Set(eff ? eff.map((d) => d.entry) : m.dq);
  const alliance = {} as MatchRp['alliance'];
  const entries: Record<string, number> = {};
  for (const side of ['red', 'blue'] as const) {
    const result = resultRp(ranking, r.winner, side);
    const bonus = hasScore ? ranking.bonus.filter((b) => bonusEarned(b, m.facts?.[side], m.rulings?.[side]?.[b.id])).map((b) => b.id) : [];
    const total = result + bonus.length;
    alliance[side] = { result, bonus, total };
    for (const s of m[side]) entries[String(s.entry)] = s.surrogate || out.has(s.entry) ? 0 : total;
  }
  return { alliance, entries };
}

/**
 * THE PLAYOFF SEEDING ORDER of the entries still eligible (status `registered`), best first.
 *
 * An entry that has a ranking row with matches played goes by its rank, ahead of every entry
 * that has none. The rest — every entry, when there were no qualifications — go by the
 * organizer's manual seed (seeded entries first, lower first), then registration order, then id.
 */
export function seedOrder(entries: CompEntryCore[], rankings: RankRow[] | null): number[] {
  const rank = new Map<number, number>();
  for (const r of rankings ?? []) if (r.played > 0) rank.set(r.entry, r.rank);
  return entries
    .filter((e) => e.status === 'registered')
    .sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
      if (a.seed != null && b.seed == null) return -1;
      if (a.seed == null && b.seed != null) return 1;
      if (a.registeredAt !== b.registeredAt) return a.registeredAt - b.registeredAt;
      return a.id - b.id;
    })
    .map((e) => e.id);
}
