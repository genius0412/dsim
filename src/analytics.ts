/**
 * Analytics events — the funnel, and the presenting sponsor's monthly report.
 *
 * Every event goes to DSIM's own sink (`trackEventBeacon` in `src/pageviews.ts` →
 * `POST /api/a/ev` → `server/analytics.ts`) and is read on the admin console's Analytics tab,
 * next to the traffic and the product tables. Vercel Web Analytics was a second sink until
 * September 2026; it was removed once the dashboard covered what it showed, and its history was
 * imported (`scripts/import-vercel-analytics.ts`).
 *
 * IT IS ALSO THE SPONSOR REPORT. The presenting sponsor is owed monthly numbers (clicks,
 * sessions, new players) and they are what the deal renews on. They come from the
 * `sponsor_*` / `player_joined` events below plus our own session counts, and the dashboard's
 * "Sponsor report" panel lays them out. `docs/sponsor.md` says which line is which.
 *
 * PRIVACY RULE FOR EVERY EVENT BELOW: names and ids never leave the app. The
 * properties here are counts and enum-ish strings, never a user id, username,
 * email, or Ko-fi transaction id. An analytics payload is the easiest place in a
 * codebase to leak personal data by accident, so the rule is "no identifiers",
 * not "be careful". `parseEvent` on the server bounds them again.
 */
// the opt-out is its own leaf module — see the note there for why it is not in this file
import { analyticsAllowed } from './analyticsPref';
import { trackEventBeacon } from './pageviews';

/** OFF unless explicitly enabled, matching how ads and auth are gated. A
 *  self-hosted or Electron build should not be firing beacons at a host it does
 *  not run on. */
const ENABLED = (import.meta.env.VITE_ANALYTICS as string | undefined)?.trim() === '1';

export function analyticsEnabled(): boolean {
  return ENABLED;
}

/** the events we care about, named so a dashboard reads as a funnel top-to-bottom */
export type AnalyticsEvent =
  | 'support_view' // reached the Support page
  | 'support_kofi_click' // clicked through to Ko-fi
  | 'support_claim_ok' // a claim succeeded
  | 'support_claim_fail' // a claim was rejected (see `reason`)
  | 'ads_shown' // an ad unit actually rendered
  | 'account_deleted'
  // ---- presenting sponsor (src/sponsor.ts) -------------------------------
  // These ARE the monthly attribution report (`docs/sponsor.md`), read off the
  // same events the app fires rather than assembled by hand.
  //
  // ⚠️ `sponsor_shown` MEANS VIEWABLE, NOT MOUNTED. It fires once the mark has
  // been at least half on screen for a continuous second (`src/ui/Sponsor.tsx`),
  // which is the industry definition of an impression and the only one a sponsor
  // can check. Counting mounts instead would bill the footer of every page a
  // visitor never scrolled to, i.e. inflate the denominator the click rate is
  // divided by — a number that flatters us is worse than no number, because it is
  // the one the renewal is argued over.
  //
  // `sponsor_dwell` carries a BUCKET string (`<5s`, `5-15s`, …), never raw
  // seconds: the dashboard groups by property VALUE, so a continuous number would
  // render as thousands of one-count rows and tell nobody anything.
  | 'sponsor_shown' // a sponsor placement was SEEN (`placement`) — the denominator
  | 'sponsor_click' // somebody clicked through to the sponsor (`placement`)
  | 'sponsor_dwell' // how long a placement stayed on screen (`placement`, `dwell`)
  | 'desktop_download' // a desktop build was taken (`os`) — the splash's only proxy
  | 'player_joined'; // a NEW account finished signing up — "new players"

/**
 * Record one event. `ENABLED`/`analyticsAllowed()` decide whether it exists at all;
 * `trackEventBeacon` adds the gate only the network send needs (a configured cloud server).
 */
export function trackEvent(
  event: AnalyticsEvent,
  props?: Record<string, string | number | boolean>,
): void {
  // `ENABLED` first, because it is a build constant: a build with analytics off never
  // touches storage at all.
  if (!ENABLED || !analyticsAllowed()) return;
  trackEventBeacon(event, props);
}
