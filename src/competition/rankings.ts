/**
 * QUALIFICATION RANKINGS AND PLAYOFF SEEDING, derived from the matches on every read.
 *
 * Nothing here is stored: a corrected result or a late DQ re-ranks the table the next time it is
 * read, and the order is a pure function of (entries, matches, settings, seed) — the final coin is
 * a hash of the competition seed, not a draw, so two reads never disagree.
 */
import type { CompEntryCore, CompMatchCore, CompSettings, RankRow, Tiebreaker } from './types';
import { hash32 } from './rng';

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
  sumScore: number;
  sumNoFoul: number;
  highScore: number;
  sumMargin: number;
  sumFouls: number;
}

/**
 * THE RANKING TABLE.
 *
 * Who is in it: entries that are `registered`, plus `withdrawn` and `disqualified` entries that
 * played at least one counted match (their results stay part of the event). Waitlisted and
 * pending entries never are.
 *
 * What counts: qualification matches that are `done` with a result, and only the slots that are
 * not surrogate appearances. An entry in `match.dq` takes no ranking points from that match and
 * it is recorded as a loss; the match still counts as played. Score statistics come only from
 * matches with a score: a forfeit (null scores) and the entry's own DQ matches count toward
 * played, W-L-T and RP but not toward `scored` or any average.
 *
 *   own score  — the alliance total
 *   no-foul    — own score minus the foul points the alliance was GIVEN (red → `redFoul`)
 *   margin     — own score minus the opponent's
 *   fouls      — the foul points it GAVE AWAY: the OPPONENT's foul field
 *
 * Order: disqualified entries last; entries that have played nothing just above them; then
 * ranking score descending, the organizer's tiebreakers in order (fewest fouls ascending, every
 * other one descending), and finally the coin `hash32(seed, entry)`, higher first. Ranks are
 * 1…n with no shared places.
 */
export function computeRankings(
  entries: CompEntryCore[],
  matches: CompMatchCore[],
  s: Pick<CompSettings, 'points' | 'tiebreakers'>,
  seed: number,
): RankRow[] {
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
      sumScore: 0,
      sumNoFoul: 0,
      highScore: 0,
      sumMargin: 0,
      sumFouls: 0,
    });
  }

  for (const m of matches) {
    if (m.stage !== 'qual' || m.status !== 'done' || !m.result) continue;
    const r = m.result;
    const hasScore = r.red != null && r.blue != null;
    for (const side of ['red', 'blue'] as const) {
      const own = side === 'red' ? r.red : r.blue;
      const other = side === 'red' ? r.blue : r.red;
      const given = side === 'red' ? r.redFoul : r.blueFoul;
      const gaveAway = side === 'red' ? r.blueFoul : r.redFoul;
      for (const slot of m[side]) {
        if (slot.surrogate) continue;
        const a = accs.get(slot.entry);
        if (!a) continue;
        const dq = m.dq.includes(slot.entry);
        a.played++;
        if (dq) {
          a.losses++;
        } else if (r.winner === 'tie') {
          a.ties++;
          a.rp += s.points.tie;
        } else if (r.winner === side) {
          a.wins++;
          a.rp += s.points.win;
        } else {
          a.losses++;
          a.rp += s.points.loss;
        }
        if (hasScore && !dq) {
          a.scored++;
          a.sumScore += own!;
          a.sumNoFoul += own! - (given || 0);
          a.highScore = a.scored === 1 ? own! : Math.max(a.highScore, own!);
          a.sumMargin += own! - other!;
          a.sumFouls += gaveAway || 0;
        }
      }
    }
  }

  const rows: RankRow[] = [];
  const coin = new Map<number, number>();
  for (const a of accs.values()) {
    if (!a.registered && a.played === 0) continue;
    const avg = (x: number): number => (a.scored > 0 ? x / a.scored : 0);
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
      avgScore: avg(a.sumScore),
      avgNoFoul: avg(a.sumNoFoul),
      highScore: a.highScore,
      avgMargin: avg(a.sumMargin),
      avgFouls: avg(a.sumFouls),
      disqualified: a.disqualified,
    });
    coin.set(a.entry, hash32(seed, a.entry));
  }

  const tb = (row: RankRow, t: Tiebreaker): number => {
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
        return -row.avgFouls;
    }
  };
  rows.sort((a, b) => {
    const dq = Number(a.disqualified) - Number(b.disqualified);
    if (dq) return dq;
    const idle = Number(a.played === 0) - Number(b.played === 0);
    if (idle) return idle;
    if (a.rs !== b.rs) return b.rs - a.rs;
    for (const t of s.tiebreakers) {
      const x = tb(a, t);
      const y = tb(b, t);
      if (x !== y) return y - x;
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
