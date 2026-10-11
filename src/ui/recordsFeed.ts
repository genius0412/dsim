import type { RecentRecord } from '../net/protocol';

/** the feed's time frames, in the board's own vocabulary (`server/boardWindow.ts`). `season` is the
 *  whole current season: a feed has no lifetime view, and the server reads `all` the same way. */
export const FEED_WINDOWS = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'season', label: 'This season' },
] as const;
export type FeedWindow = (typeof FEED_WINDOWS)[number]['key'];

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
