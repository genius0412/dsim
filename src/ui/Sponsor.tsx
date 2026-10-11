import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import {
  SPONSOR,
  sponsorActive,
  sponsorLink,
  sponsorLogoWidth,
  type SponsorPlacement,
} from '../sponsor';
import { SPONSOR_LOGO_DARK, SPONSOR_LOGO_LIGHT } from './sponsorAssets';
import { trackEvent } from '../analytics';

/**
 * THE PRESENTING SPONSOR, ON SCREEN.
 *
 * One module for every placement, because the thing that must not drift between
 * them is the LINK and the EVENT — a placement that forgets its `utm_medium` or
 * its `sponsor_click` is invisible in the monthly report, and a placement nobody
 * can measure is one we cannot renew on. Every component here goes through
 * `SponsorMark`, so that cannot be forgotten by adding a surface.
 *
 * ⚠️ NOT THE AD PATH, AND DELIBERATELY SO. `AdSlot`/`useAds` render nothing on a
 * touch device, nothing in the Electron build, nothing for a supporter, and
 * nothing when AdSense is unconfigured — which between them is the phone, the
 * desktop app, and the most engaged players on the service. A presenting sponsor
 * was sold the app, not the leftover inventory, so none of these components read
 * `useAds()` at all. The only gate is `sponsorActive()`, i.e. the term.
 */

/** the artwork. Two <img>s, one per theme, in the SAME reserved box.
 *
 *  WHY TWO AND NOT A SWAP: the box is sized from `SPONSOR.logoW/logoH` before
 *  either file has loaded, so nothing moves when they do — `npm run shiftaudit`
 *  fails on any element shifting more than 0.5px, and an image that sizes itself
 *  on load IS that shift. Toggling `src` from JS would also re-request on every
 *  theme change and flash. CSS picks the visible one; the other costs a decode.
 *
 *  ⚠️ THE IN-GAME CHIP THEMES TOO, even though the field underneath it never does.
 *  It is not the field the logo has to read against — it is the chip's own plate,
 *  and that plate is `--ds-hud`, which INVERTS (a white card on the dark field in
 *  light theme, exactly like every other HUD chip). Pinning the light-ink cut there
 *  "because the field is dark" puts a white wordmark on a white card. The cut
 *  follows the PLATE: under the 3D view's scrim that plate is dark in BOTH themes,
 *  so shell.css pins the light-ink cut there (`.game-root.view-3d …`). The one
 *  surface that genuinely does not theme is the burned-in replay mark, whose plate
 *  is painted dark by `replayOverlay.ts` — and that one is canvas, not this.
 *
 *  EXPORTED for `Contributors.tsx`'s "Presented by" credit: that page is not one of
 *  `SPONSOR_PLACEMENTS`, so it renders the artwork through this pure component
 *  rather than through `SponsorMark`, which is the ONE thing allowed to fire the
 *  impression/click events for a contracted placement — see the note there. */
export function SponsorLogo({ h }: { h: number }) {
  const w = sponsorLogoWidth(h);
  // the NAME, not "… logo": inside a link that word is noise in the link's name
  const alt = SPONSOR.name;
  return (
    <span className="sponsor-logo-swap">
      <img
        className="sponsor-logo on-light"
        src={SPONSOR_LOGO_LIGHT}
        width={w}
        height={h}
        alt={alt}
      />
      {/* the dark cut carries alt="" — the pair is ONE logo, and two identical alts
          would have a screen reader announce the sponsor twice on every surface */}
      <img className="sponsor-logo on-dark" src={SPONSOR_LOGO_DARK} width={w} height={h} alt="" />
    </span>
  );
}

/* ------------------------------------------------- measuring the placement ---- */

/** Half the mark on screen, for a continuous second — the MRC display standard,
 *  and the one Offset's own ad vendor will quote back at us. Anything looser and
 *  the denominator stops meaning "seen". */
const VIEWABLE_RATIO = 0.5;
const VIEWABLE_MS = 1000;

/** dwell as a BUCKET, never a raw second count: the dashboard groups events by
 *  property VALUE, so a continuous number would render as one row per session. */
function dwellBucket(ms: number): string {
  const s = ms / 1000;
  if (s < 5) return '<5s';
  if (s < 15) return '5-15s';
  if (s < 60) return '15-60s';
  if (s < 300) return '1-5m';
  return '5m+';
}

/**
 * THE IMPRESSION, AND HOW LONG IT LASTED.
 *
 * ⚠️ AN IMPRESSION IS NOT A MOUNT, and the difference is the whole number. The
 * footer mark is in the DOM of every shell page whether or not the visitor ever
 * scrolls far enough to see it, and the home lockup is below a 64px title on a
 * short phone. Firing on mount therefore counts views that did not happen, and it
 * inflates exactly the figure the click rate is divided by — so the one number we
 * would be overstating is the one the renewal is argued over. Better to under-count
 * honestly: this fires only after the mark has been at least `VIEWABLE_RATIO` on
 * screen for `VIEWABLE_MS` unbroken, and a backgrounded tab is not on screen.
 *
 * DWELL IS THE SECOND HALF OF THE ANSWER. One impression on a twenty-minute
 * practice session and one on a three-second bounce are the same row in a count of
 * impressions, and they are not the same thing to a sponsor. The in-game chip is
 * the longest-exposure placement in the app and had no way of showing it.
 * Accumulated visible time flushes ONCE per mount — at unmount, or at `pagehide`
 * for the surfaces (the footer) that never unmount because the tab just closed.
 *
 * PRIVACY IS UNCHANGED: the payload is a placement name and a bucket string. No
 * user, no session, no page, no timestamp (`src/analytics.ts`).
 */
function useSponsorExposure(
  ref: RefObject<HTMLAnchorElement | null>,
  placement: SponsorPlacement,
): void {
  useEffect(() => {
    const el = ref.current;
    let counted = false; // the impression has fired — once per mount
    let flushed = false; // the dwell has fired — once per mount
    let since = 0; // timestamp the current visible stretch began, 0 when hidden
    let total = 0; // visible ms banked from earlier stretches
    let timer: ReturnType<typeof setTimeout> | undefined;

    const impression = (): void => {
      if (counted) return;
      counted = true;
      trackEvent('sponsor_shown', { placement });
    };

    const enter = (): void => {
      if (since) return;
      since = Date.now();
      // the clock starts on ENTRY, not on the impression: a mark that leaves at
      // 900ms was never seen, and one that stays is credited from when it arrived.
      if (!counted) timer = setTimeout(impression, VIEWABLE_MS);
    };

    const leave = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (since) {
        total += Date.now() - since;
        since = 0;
      }
    };

    /** the only place dwell is reported. Guarded because `pagehide` and unmount
     *  both fire on a normal tab close, and a double count is a wrong number. */
    const flush = (): void => {
      leave();
      if (flushed || !counted || total <= 0) return;
      flushed = true;
      trackEvent('sponsor_dwell', { placement, dwell: dwellBucket(total) });
    };

    let onScreen = false;
    const onVisibility = (): void => {
      // a tab in the background is not an impression, however long it sits there
      if (document.visibilityState === 'hidden') leave();
      else if (onScreen) enter();
    };

    let io: IntersectionObserver | undefined;
    if (el && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            onScreen = e.isIntersecting && e.intersectionRatio >= VIEWABLE_RATIO;
            if (onScreen && document.visibilityState !== 'hidden') enter();
            else leave();
          }
        },
        { threshold: [0, VIEWABLE_RATIO, 1] },
      );
      io.observe(el);
    } else {
      // NO OBSERVER (an old browser, a test renderer): fall back to the old
      // behaviour rather than reporting nothing. Under-reporting a placement
      // somebody paid for is the one failure mode worth avoiding here, and this
      // path cannot tell whether the mark is on screen at all.
      onScreen = true;
      enter();
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      io?.disconnect();
      flush();
    };
  }, [ref, placement]);
}

/**
 * The clickable mark itself — the only thing that knows the URL and the events.
 *
 * `rel="noreferrer"` like every other outbound link in the app. The attribution
 * does not need the referrer: the UTM params carry it and survive a
 * referrer-stripped hop, which is exactly why they are there.
 */
function SponsorMark({
  placement,
  h,
  className,
  children,
}: {
  placement: SponsorPlacement;
  h: number;
  className: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  useSponsorExposure(ref, placement);
  return (
    <a
      ref={ref}
      className={className}
      href={sponsorLink(placement)}
      target="_blank"
      rel="noreferrer"
      // the name is spoken whole, with the new-tab cue a sighted user gets from the browser; no
      // `title` — it only repeated the name as a hover tooltip
      aria-label={`${SPONSOR.presents} ${SPONSOR.name} (opens in new tab)`}
      onClick={() => trackEvent('sponsor_click', { placement })}
    >
      {children}
      <SponsorLogo h={h} />
    </a>
  );
}

/** HOME MENU — "Presented by [mark]", under the app title.
 *
 *  Its own line rather than folded into `.ds-eyebrow`: that eyebrow already names
 *  the SEASON and its presenter ("BIOBUZZ presented by RTX"), and two different
 *  "presented by"s in one sentence would read as one claim about one thing. The
 *  season's presenter is FIRST's; this one is the app's. */
export function SponsorPresents() {
  if (!sponsorActive()) return null;
  return (
    <p className="ds-home-presents">
      {/* h=32: the home lockup is the announcement, and at 20 it read as a
          footnote under a 64px title. The label beside it stays small on purpose —
          what a reader should come away with is the sponsor's mark, not the words
          "presented by". */}
      <SponsorMark placement="home" h={32} className="sponsor-mark">
        <span className="sponsor-pre">{SPONSOR.presents}</span>
      </SponsorMark>
    </p>
  );
}

/** FOOTER — on every shell screen, which is what makes "presented by" true of the
 *  APP rather than of its landing page. Smaller than the home lockup on purpose:
 *  it is a persistent credit, not a repeated announcement. */
export function SponsorFooterMark() {
  if (!sponsorActive()) return null;
  return (
    <span className="ds-foot-sponsor">
      <SponsorMark placement="footer" h={14} className="sponsor-mark">
        <span className="sponsor-pre">{SPONSOR.presents}</span>
      </SponsorMark>
    </span>
  );
}

/** TOP STRIP — the banner that fills the reserved ad strip at the bottom of every shell screen whenever
 *  there is no ad to show. Rendered by `BannerStrip`, which owns the sponsor-active check and the
 *  reserved height, so this is only the mark. */
export function SponsorStripMark({ h }: { h: number }) {
  return (
    <SponsorMark placement="strip" h={h} className="sponsor-mark strip">
      <span className="sponsor-pre">{SPONSOR.presents}</span>
    </SponsorMark>
  );
}

/** DOWNLOAD PAGE — the largest lockup in the app. The desktop build is the thing
 *  being handed over here, and the splash the user sees when they run it carries
 *  the same mark, so the two read as one handoff rather than as a surprise. */
export function SponsorDownloadMark() {
  if (!sponsorActive()) return null;
  return (
    <div className="ds-dl-sponsor">
      <SponsorMark placement="download" h={28} className="sponsor-mark stacked">
        <span className="sponsor-pre">{SPONSOR.presents}</span>
      </SponsorMark>
    </div>
  );
}

/**
 * IN-GAMEPLAY — the top-LEFT corner, on the MENU / RESET line.
 *
 * IT THEMES WITH THE CHIP, not with the field — see the note on `SponsorLogo`.
 *
 * It rides `.game-buttons`, which is the one top-corner cluster the game screen
 * renders in EVERY layout — the status chips on the right are a fine-pointer
 * cluster only, so a mark living there was absent on the touch layout unless a
 * second floating copy existed to cover it. One render, every device.
 *
 * `.game-buttons` sits inside `.hud`, which is `pointer-events: none` so the canvas
 * keeps the drag; `.sponsor-chip` re-enables them on itself exactly like `.game-btn`
 * beside it, because this is one of the two things up there meant to be clicked.
 *
 * IT CARRIES THE WORDS, like every other placement. "Presented by" is the claim
 * that was bought; a bare logo in a corner of a game screen is decoration.
 */
export function SponsorGameChip() {
  if (!sponsorActive()) return null;
  // h=24 against the row's 12px type: the mark is the tallest thing on the line
  // and reads as the presenter rather than as one more button.
  return (
    <SponsorMark placement="game" h={24} className="sponsor-chip">
      <span className="sponsor-pre">{SPONSOR.presents}</span>
    </SponsorMark>
  );
}
