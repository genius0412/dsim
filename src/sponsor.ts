/**
 * THE PRESENTING SPONSOR OF THE APP.
 *
 * Distinct from `Season.presenter` (`src/seasons.ts`) and the two must never be
 * conflated. A season's presenter is a FACT about the FTC game — DECODE and
 * BIOBUZZ are presented by RTX, Chain Reaction by goBILDA — and it is not ours to
 * sell. This module is the OTHER thing: who presents DSIM, the application. The
 * home menu therefore reads
 *
 *     BIOBUZZ presented by RTX · 2D Driver Practice      (the season eyebrow)
 *     DSIM                                               (the app)
 *     …presented by Offset Robotics                      (this module)
 *
 * and both stay true at once.
 *
 * DOM-FREE ON PURPOSE. The artwork is imported through Vite in
 * `src/ui/sponsorAssets.ts`, because the Electron build runs from `file://` with
 * `base: './'` and an absolute `/sponsors/…` path out of `public/` does not
 * resolve there — the desktop app is one of the surfaces the placement was bought
 * for, so a logo that silently 404s in it is the one failure that matters. Keeping
 * the FACTS here (name, link, term, footprint) means the headless smoke suite can
 * import and assert them without a bundler.
 */

/** every surface the mark appears on. The value is what lands in `utm_medium`, so
 *  the monthly attribution report can say WHICH placement earned a click rather
 *  than only that one happened. Adding a placement means adding it here first —
 *  `sponsorLink` takes this type, not a string. */
export const SPONSOR_PLACEMENTS = [
  'home',
  'footer',
  'game',
  'download',
  'splash',
  'replay',
] as const;
export type SponsorPlacement = (typeof SPONSOR_PLACEMENTS)[number];

export interface SponsorTerm {
  /** ISO date the placement goes live (inclusive) */
  from: string;
  /** ISO date it comes down (EXCLUSIVE — the first day it is gone) */
  until: string;
}

export interface Sponsor {
  /** exactly as the company writes it — this string is rendered verbatim */
  name: string;
  /** the destination of every clickable placement, before UTM params */
  url: string;
  /** the line the app says about them, without the name */
  presents: string;
  /**
   * The artwork's INTRINSIC size, from the files the sponsor ships (1735×438,
   * i.e. 3.96:1 — a horizontal wordmark lockup). Every placement sizes by HEIGHT
   * and derives width from this ratio, so a re-cut logo at a different resolution
   * needs no CSS change, and the reserved box is exact BEFORE the image loads —
   * which is what keeps `npm run shiftaudit` green (an image that sizes itself on
   * load is a layout shift by definition).
   */
  logoW: number;
  logoH: number;
  /** the season this was bought for. See `sponsorActive`. */
  term: SponsorTerm;
}

/**
 * Offset Robotics — presenting sponsor for the BIOBUZZ season.
 *
 * ⚠️ THE TERM ENDS ON ITS OWN. `until` is the day after the placement's last, and
 * `sponsorActive` is false from then on, so the chrome comes down without anybody
 * remembering to take it down. A renewal is a deliberate edit to this one date,
 * which is the point: the deal renews on the monthly numbers (see
 * `docs/sponsor.md`), so it should not keep running by default.
 */
export const SPONSOR: Sponsor = {
  name: 'Offset Robotics',
  url: 'https://offsetrobotics.com',
  presents: 'Presented by',
  logoW: 1735,
  logoH: 438,
  // BIOBUZZ kickoff (2026-09-12) through the day before the next season's.
  term: { from: '2026-09-12', until: '2027-09-12' },
};

/**
 * KILL SWITCH, not a feature flag. `VITE_SPONSOR=0` removes every placement from
 * a build. It exists for the one case the contract does not cover — a fork or a
 * self-hosted copy that is not ours to sell — and NOT for the desktop/LAN builds,
 * which are explicitly in scope and default to on. Anything other than the exact
 * string `0` leaves the sponsor enabled, so a missing or misspelled env var fails
 * toward honouring the deal rather than quietly voiding it.
 */
const DISABLED = (import.meta.env?.VITE_SPONSOR as string | undefined)?.trim() === '0';

/** parse an ISO `YYYY-MM-DD` as UTC midnight. `new Date('2026-09-12')` already does
 *  this, but `new Date('2026-9-12')` is LOCAL time — so the format is asserted
 *  rather than assumed, and a malformed date reads as NaN, which every comparison
 *  below answers `false` to (i.e. the sponsor is shown, not hidden). */
function day(iso: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : NaN;
}

/**
 * Is the sponsorship live right now?
 *
 * Takes `now` as an ARGUMENT so the term is testable without touching the clock —
 * the same split `seasonVisibleOn` uses for the release channel.
 *
 * ⚠️ A CLOCK IT CANNOT TRUST FAILS TOWARD SHOWING THE MARK. An unparseable term
 * makes both comparisons false and the sponsor stays up; the alternative — a
 * device with a wrong date silently hiding a placement somebody paid for — is the
 * failure we can neither see nor explain.
 */
export function sponsorActive(now: number = Date.now()): boolean {
  if (DISABLED) return false;
  const from = day(SPONSOR.term.from);
  const until = day(SPONSOR.term.until);
  return !(now < from) && !(now >= until);
}

/**
 * The sponsor's link for one placement, tagged for attribution.
 *
 * UTM rather than a redirect of our own: the sponsor reads these in their OWN
 * analytics, which is what lets the monthly report be checkable by them instead of
 * asserted by us. NOTHING PERSONAL GOES IN HERE — the three params are constants
 * and a placement name, never a user, a session, or a match. A query string is the
 * easiest place in a codebase to leak an identifier, so the rule is "constants
 * only", not "be careful" (the same rule `src/analytics.ts` states for events).
 */
export function sponsorLink(placement: SponsorPlacement): string {
  const u = new URL(SPONSOR.url);
  u.searchParams.set('utm_source', 'dsim');
  u.searchParams.set('utm_medium', placement);
  u.searchParams.set('utm_campaign', 'biobuzz-2026');
  return u.toString();
}

/** "Presented by Offset Robotics" — for plain-text surfaces (the desktop splash,
 *  the burned-in replay mark, a meta description). Anything that can render the
 *  ARTWORK should render the artwork; this is the fallback, not the default. */
export function sponsorLine(): string {
  return `${SPONSOR.presents} ${SPONSOR.name}`;
}

/** the width the artwork occupies at `h` CSS pixels tall, rounded to a whole pixel.
 *  Every placement reserves its box with this BEFORE the image loads. */
export function sponsorLogoWidth(h: number): number {
  return Math.round((h * SPONSOR.logoW) / SPONSOR.logoH);
}
