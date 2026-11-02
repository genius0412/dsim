/**
 * THE RECORDS FEED (`GET /api/records/recent`): new No.1s and top-3 scores over a time frame.
 *
 * A feed entry is a run that, AT THE MOMENT IT WAS SET, was its board entry's new best (a player,
 * or a duo pair) and ranked 1 to 3 among every entry's best so far, the way the board ranks them:
 * score descending, a tie sharing the place. Nothing is stored for it: the rank is replayed from the
 * `records` rows, which keep every run (`created_at` per row), so no migration and nothing to
 * backfill. If this is ever measured too slow, the escape hatch is a `rank_at_time` column written in
 * `submitRecord`, which is a migration and a separate decision.
 *
 * Pure and clock-free: the caller fetches the board's rows and hands them over, so `npm test` holds
 * the ranking without a database.
 */
import type { RecentRecord } from '../src/net/protocol';

/** one run on one board, as the feed needs it (a board is game x season x mode x era) */
export interface FeedRow {
  id: number | string;
  userId: string;
  partnerId: string | null;
  score: number;
  /** ISO instant */
  createdAt: string;
  replayId: string | null;
}

/** a feed entry before the names are joined on */
export type FeedEntry = Pick<RecentRecord, 'userId' | 'score' | 'rank' | 'createdAt' | 'replayId'> & {
  partnerId: string | null;
};

/** how far down the board counts: No.1, No.2, No.3 */
export const FEED_TOP = 3;

/**
 * The board entry a run belongs to, as `entryCols` in `repo.ts` keys it: the player, or a duo's
 * UNORDERED pair, so (A, B) and (B, A) are one entry. Only an identity here, never compared
 * against the database's order, so a JS sort is fine.
 */
function entryOf(r: Pick<FeedRow, 'userId' | 'partnerId'>): string {
  return r.partnerId ? [r.userId, r.partnerId].sort().join('\n') : r.userId;
}

/**
 * The feed of one board.
 *
 * @param rows   EVERY run on the board, in any order (the board's whole history is needed: a rank
 *               is "among the bests so far", so a window cannot be cut from the rows first)
 * @param since  window start (inclusive, ISO), or null for the whole board
 * @returns      newest first, at most `limit`
 */
export function feedFromRows(rows: readonly FeedRow[], since: string | null, limit: number): FeedEntry[] {
  const ordered = [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );
  /** each entry's best so far */
  const best = new Map<string, number>();
  const out: FeedEntry[] = [];
  for (const r of ordered) {
    const key = entryOf(r);
    const prev = best.get(key);
    // only a NEW personal best can be a new rank: a repeat or a worse run changes nobody's place
    if (prev !== undefined && r.score <= prev) continue;
    best.set(key, r.score);
    if (since !== null && r.createdAt < since) continue;
    // a STRICTLY higher best is ahead; an equal one shares the place, as it does on the board
    let ahead = 0;
    for (const [k, b] of best) if (k !== key && b > r.score) ahead++;
    const rank = ahead + 1;
    if (rank <= FEED_TOP) {
      out.push({ userId: r.userId, partnerId: r.partnerId, score: r.score, rank, createdAt: r.createdAt, replayId: r.replayId });
    }
  }
  return out.reverse().slice(0, Math.max(0, limit));
}
