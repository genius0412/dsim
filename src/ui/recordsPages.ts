/**
 * THE TABS OF RECORDS (`docs/records-redesign.md`, built 2026-11-04). `Records.tsx` draws one tab per
 * entry and one component per key, so adding a page is ONE entry here plus its component: the tab
 * strip, the URL (`/records/<key>`) and the routing table all read it.
 *
 * THERE IS NO HUB. `/records` used to be a page of three link cards and a feed, a click on the way
 * to every board; it now opens Leaderboards, and every other old address lands on its tab
 * (`recordsViewOf`). Leaderboards is the first entry because it is what the section is for.
 *
 * DOM-free on purpose, so `npm test` can hold the keys against the router. The component for a key
 * lives in `Records.tsx`, typed `Record<RecordsPageKey, …>`, so a page added here with no component
 * fails the typecheck rather than rendering nothing.
 */
export const RECORDS_PAGES = [
  { key: 'leaderboard', label: 'Leaderboards', short: 'Boards' },
  { key: 'career', label: 'My records', short: 'My records' },
  { key: 'achievements', label: 'Achievements', short: 'Badges' },
] as const;

export type RecordsPageKey = (typeof RECORDS_PAGES)[number]['key'];
// `short` is the tab's label on a phone, where the three full ones and the search button do not fit one
// line (they wrapped "My records" onto two and cost the board 50px); the accessible name stays `label`

/** the tab `/records` and every unknown or retired sub-path opens on */
export const RECORDS_DEFAULT: RecordsPageKey = 'leaderboard';

export function isRecordsPage(s: string | null | undefined): s is RecordsPageKey {
  return !!s && RECORDS_PAGES.some((p) => p.key === s);
}

/** a `/records/<sub>` path segment to the tab it opens: the old hub (`/records`, `/records/hub`) and
 *  anything unknown are Leaderboards */
export function recordsViewOf(sub: string | null | undefined): RecordsPageKey {
  return isRecordsPage(sub) ? sub : RECORDS_DEFAULT;
}
