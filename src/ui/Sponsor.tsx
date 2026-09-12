import { useEffect, type ReactNode } from 'react';
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
 *  "because the field is dark" puts a white wordmark on a white card. The one
 *  surface that genuinely does not theme is the burned-in replay mark, whose plate
 *  is painted dark by `replayOverlay.ts` — and that one is canvas, not this. */
function SponsorLogo({ h }: { h: number }) {
  const w = sponsorLogoWidth(h);
  const alt = `${SPONSOR.name} logo`;
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
  // ONE impression per mount, per placement. The property is the placement name
  // and nothing else — no user, no session, no page id (the privacy rule stated
  // in src/analytics.ts). This is the denominator the click rate is measured
  // against; without it "12 clicks" is a number with no scale attached to it.
  useEffect(() => {
    trackEvent('sponsor_shown', { placement });
  }, [placement]);
  return (
    <a
      className={className}
      href={sponsorLink(placement)}
      target="_blank"
      rel="noreferrer"
      title={`${SPONSOR.presents} ${SPONSOR.name}`}
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
      <SponsorMark placement="home" h={20} className="sponsor-mark">
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
 * IN-GAMEPLAY — the top-right corner chip, over the field.
 *
 * IT THEMES WITH THE CHIP, not with the field — see the note on `SponsorLogo`.
 *
 * Rendered OUTSIDE `.hud`, which is `pointer-events: none` so the canvas keeps the
 * mouse — this is the one overlay on the game screen that has to be clickable, and
 * re-enabling pointer events on a child of a decorative layer is how a HUD element
 * ends up eating drags meant for the field. It is a sibling of the canvas inside
 * `.game-root` instead, which is already the positioning context for every overlay.
 */
export function SponsorGameChip() {
  if (!sponsorActive()) return null;
  return <SponsorMark placement="game" h={16} className="sponsor-chip" />;
}
