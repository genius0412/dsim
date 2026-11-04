import type { RecentRecord } from '../net/protocol';

/**
 * LATEST RECORDS, the Leaderboards tab's side column (`LatestRecords.tsx`): the season's new No.1s
 * and top-3 scores, newest first. It had a time-frame picker (Today / This week / This month / This
 * season); that went with the board's Window control, and the column always reads the season.
 */
export const LATEST_ROWS = 8;

/** a short age, like every other "ago" in the app: "just now", "5m ago", "3h ago", "4d ago" */
export function feedAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** what the entry says, after the player's name: "took No.1 in Solo with 412" (a duo adds the partner) */
export function feedVerb(r: Pick<RecentRecord, 'rank' | 'mode' | 'score' | 'partnerHandle'>): string {
  const board = r.mode === 'duo' ? 'Duo' : 'Solo';
  const place = r.rank === 1 ? 'took No.1' : `reached No.${r.rank}`;
  return `${place} in ${board} with ${r.score}`;
}
