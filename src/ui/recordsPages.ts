/**
 * THE PAGES OF RECORDS. The hub (`/records`) links to every entry here, and `Records.tsx` renders
 * one component per key, so adding a page is ONE entry in this list plus its component: the hub's
 * link grid, the URL (`/records/<key>`), and the routing table all read it.
 *
 * DOM-free on purpose, so `npm test` can hold the keys against the router. The component for a key
 * lives in `Records.tsx`, typed `Record<RecordsPageKey, …>`, so a page added here with no component
 * fails the typecheck rather than rendering nothing.
 */
export const RECORDS_PAGES = [
  { key: 'leaderboard', label: 'Leaderboards', hint: 'Best runs and ranked ratings' },
  { key: 'career', label: 'My records', hint: 'Your runs, matches and awards' },
  { key: 'players', label: 'Players', hint: 'Find a player by name' },
] as const;

export type RecordsPageKey = (typeof RECORDS_PAGES)[number]['key'];

/** `/records` itself: the landing page. Not a registry entry, because it is what the entries hang off. */
export const RECORDS_HUB = 'hub' as const;
export type RecordsView = RecordsPageKey | typeof RECORDS_HUB;

export function isRecordsPage(s: string | null | undefined): s is RecordsPageKey {
  return !!s && RECORDS_PAGES.some((p) => p.key === s);
}

/** a `/records/<sub>` path segment to the view it opens: anything unknown (or absent) is the hub */
export function recordsViewOf(sub: string | null | undefined): RecordsView {
  return isRecordsPage(sub) ? sub : RECORDS_HUB;
}
