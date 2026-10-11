/**
 * THE RECORDS FEED (`GET /api/records/recent`): new No.1s and top-3 scores over a time frame.
 *
 * A feed entry is a run that, AT THE MOMENT IT WAS SET, was its player's new personal best and
 * ranked 1 to 3 on its board: each player's best run so far, ordered the way the board orders them
 * (score descending, then who set it first). Nothing is stored for it: the rank is replayed from the
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
  /** each player's best so far */
  const best = new Map<string, number>();
  const out: FeedEntry[] = [];
  for (const r of ordered) {
    const prev = best.get(r.userId);
    // only a NEW personal best can be a new rank: a repeat or a worse run changes nobody's place
    if (prev !== undefined && r.score <= prev) continue;
    best.set(r.userId, r.score);
    if (since !== null && r.createdAt < since) continue;
    // everyone else with a best at least this high is ahead: higher, or equal and set EARLIER
    // (every best in the map was set before this run, so a tie is theirs)
    let ahead = 0;
    for (const [uid, b] of best) if (uid !== r.userId && b >= r.score) ahead++;
    const rank = ahead + 1;
    if (rank <= FEED_TOP) {
      out.push({ userId: r.userId, partnerId: r.partnerId, score: r.score, rank, createdAt: r.createdAt, replayId: r.replayId });
    }
  }
  return out.reverse().slice(0, Math.max(0, limit));
}
