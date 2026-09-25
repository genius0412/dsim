/**
 * THE PATH SCRUBBER, on its own leaf so the server can run it too.
 *
 * `src/pageviews.ts` runs it in the browser before a page view is sent, so an id never leaves
 * the device. `server/analyticsImport.ts` runs it over the raw request paths in a Vercel export
 * before they are stored. No DOM, no env: the server typechecks and imports this file, and
 * `pageviews.ts` (which touches `window`) re-exports it for the smoke suite.
 */

/**
 * SEGMENTS THAT INTRODUCE AN ID. `/replay/<uuid>` and `/profile/<username>` are the two
 * routes DSIM has today (`parseScreen` in `src/ui/App.tsx`), and the segment after either one
 * is a value that identifies a match or a person.
 *
 * Named rather than pattern-matched because the NAME is the reliable part: a username is
 * `[a-z0-9]{4,20}`, which is indistinguishable from the word `records` by shape alone. The
 * general patterns below are the safety net for a route nobody has written yet, not the rule.
 */
const ID_PARENTS: Record<string, string> = {
  replay: ':id',
  profile: ':name',
  u: ':name',
  user: ':id',
  room: ':code',
  match: ':id',
};

/** looks like an id even though nothing named it one — the net under a route added later */
function looksLikeId(seg: string): boolean {
  if (seg.length > 24) return true; // no static route segment in this app is near that long
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^[0-9a-f]{12,}$/i.test(seg)) return true; // a bare hex id
  if (/^[a-z]{3}-[a-z0-9]{4,}$/i.test(seg)) return true; // a region-coded room code (iad-abc123)
  if (/^\d+$/.test(seg) && seg.length > 3) return true; // a numeric id, but not `/act/2`
  return false;
}

/**
 * A URL as it may be recorded: path only, query and fragment gone, every id-like segment
 * replaced by a placeholder, capped at a length no real route reaches.
 *
 * ⚠️ THE QUERY STRING GOES FIRST AND UNCONDITIONALLY. `?token=` is how a password-reset and
 * an email-verification link arrive (`src/ui/entryToken.ts`), and `App`'s mount effect strips
 * it from the address bar specifically so it cannot reach "a copied link, a referrer, an
 * analytics beacon" — the comment there names this beacon before it existed. Reading
 * `pathname` alone would be enough today; taking a whole href and discarding everything after
 * `?` is enough whatever a caller hands over tomorrow.
 */
export function normalizePath(raw: string): string {
  const path = raw.split('#')[0].split('?')[0] || '/';
  const segs = path.split('/');
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) {
      out.push(seg);
      continue;
    }
    const parent = i > 0 ? segs[i - 1].toLowerCase() : '';
    if (parent && ID_PARENTS[parent]) out.push(ID_PARENTS[parent]);
    else if (looksLikeId(seg)) out.push(':id');
    else out.push(seg.slice(0, 32));
  }
  const joined = out.join('/') || '/';
  return joined.length > 128 ? joined.slice(0, 128) : joined;
}
