import type { ReactNode } from 'react';
import { showConsentSettings } from '../ads/adsense';
import { APP_NAME, seasonFor } from '../seasons';
import { SUPPORT_ENABLED } from '../net/env';
import { inDiscordActivity } from '../net/discordActivity';
import { useLanEnabled } from './useLanEnabled';
import type { GameId } from '../games/types';
import { MenuAd } from './AdSlot';
import { FriendsPanel } from './FriendsPanel';
import { FriendToasts } from './friendsContext';
import { Logo } from './Logo';
import { NavRail } from './NavRail';
import { SponsorFooterMark } from './Sponsor';
import { usePresence } from './usePresence';
import { MaintenanceBanner } from './MaintenanceBanner';
import { LanBanner } from './LanBanner';
import { PresenceProvider, QueueCounts } from './QueueCounts';
import type { Presence, RoomInvite } from '../net/api';

export type ShellNav = 'home' | 'play' | 'configure' | 'records' | 'profile' | 'admin';

/** ambient "who's around" chip in the top bar: a live-green dot + the online /
 * signed-in tally. Renders nothing until presence lands (server unconfigured /
 * asleep / first poll pending) — `.ds-bar-live` holds the space so the bar does
 * not re-flow when it does. */
function PresenceChip({ p }: { p: Presence }) {
  return (
    <span className="ds-presence">
      <span className="ds-presence-dot" />
      <b>{p.online}</b> online
      {p.signedIn > 0 && <span className="ds-presence-sub">· {p.signedIn} signed in</span>}
    </span>
  );
}

/**
 * App chrome for the routed content screens. The top bar is deliberately thin —
 * brand, presence, and the auth slot — because navigation lives elsewhere:
 *
 *   HOME  (`showRail={false}`) — the destinations are the centered main menu.
 *   EVERY OTHER SCREEN         — the same destinations as a persistent left rail.
 *
 * Full-screen surfaces (the game, lobby, record run, ranked, replay) render
 * outside this shell entirely and own their own back/Esc semantics.
 */
export function AppShell({
  active,
  onNav,
  right,
  children,
  showAdmin,
  showRail = true,
  onDownload,
  onContributors,
  onPrivacy,
  onTerms,
  onDonate,
  onChangelog,
  signedIn,
  onOpenProfile,
  onJoinInvite,
  onSpectate,
  myUserId,
  game,
}: {
  active: ShellNav;
  onNav: (n: ShellNav) => void;
  right?: ReactNode;
  children: ReactNode;
  /** show the Admin entry (only the signed-in admin account) */
  showAdmin?: boolean;
  /** false on home, where the menu itself is the navigation */
  showRail?: boolean;
  /** Download is a footer destination, not one of the four `ShellNav` tabs */
  onDownload: () => void;
  /** Contributors, likewise a footer destination (but public, unlike Download) */
  onContributors: () => void;
  /** Privacy policy — public, and a hard prerequisite for the AdSense application */
  onPrivacy: () => void;
  /** Terms of use — public, paired with the privacy policy */
  onTerms: () => void;
  /** Support/donate page — Ko-fi link + the supporter-membership claim flow */
  onDonate: () => void;
  /** Changelog, likewise a footer destination (public) — replaces the old bare GitHub link */
  onChangelog: () => void;
  /** drives the friends panel: signed out it shows a sign-in prompt and never polls */
  signedIn: boolean;
  /** click-through from a friend/search row to that player's public profile */
  onOpenProfile: (username: string) => void;
  /** a friend's "Join" click on a room invite, from anywhere the panel is open */
  onJoinInvite: (invite: RoomInvite) => void;
  /** "Watch" on a friend who is mid-match — spectates their room read-only */
  onSpectate: (room: string, region?: string) => void;
  /** the signed-in account's own user id — drives the panel's "Recently played"
   * suggestions (opponents/teammates from recent matches you can friend) */
  myUserId?: string | null;
  /** the selected game — the app bar names its season, and footer links carry its URL prefix */
  game: GameId;
}) {
  const lanOn = useLanEnabled();
  const presence = usePresence();
  const season = seasonFor(game);
  /**
   * ⚠️ THE AUTH SLOT IS NOT RENDERED INSIDE A DISCORD ACTIVITY, because nothing behind it
   * can succeed there and the failure blames the wrong thing.
   *
   * `authEnabled` is a BUILD constant and it is true on the bundle the activity loads, so
   * App hands this slot a `ProfileMenu` — a "?" avatar, in the top bar of the FIRST screen a
   * participant sees, whose popover offers sign-in. Discord's CSP blocks the auth host, so the
   * fetch rejects with a bare `TypeError`, and the sentence that reaches the player is
   * "Couldn’t reach the sign-in service. Check your connection and try again." — advice that
   * can never work, on a page that is at that moment showing a live player count.
   *
   * Dropping it is the same ruling `compete={!inActivity}` already made for the ranked tiles
   * one call up: an account, a download and a local network are all unreachable in the embed,
   * and advertising one is a dead end. It also matches what a build WITHOUT auth renders here —
   * `ServerMenu`, which returns null in the activity anyway, since the proxy's URL mapping
   * collapses the server list to one entry and there is no region to pick (the activity pins
   * its own). So this is the no-auth bar, not a new third state.
   *
   * `inDiscordActivity()` and not `discordGroup()`: this is a question about being EMBEDDED,
   * which is host-based and cannot be lost, not about which party we are in — see the note on
   * the predicate itself, and App's `inActivity`.
   */
  const inActivity = inDiscordActivity();
  return (
    // ONE poller for the whole shell — every menu that shows queue depth reads this
    // value rather than starting its own (see QueueCounts.tsx)
    <PresenceProvider value={presence} game={game}>
    <div className="ds-app">
      <header className="ds-bar">
        <button className="ds-mark" onClick={() => onNav('home')} aria-label={`${APP_NAME} home`}>
          <Logo size={24} />
          {APP_NAME}
        </button>
        {/* WHICH SEASON IS LOADED, on every shell screen (owner, 2026-09-22: "the UI does not show
            which game mode I am in"). The app is DSIM and the season is what is loaded, so the
            two are separate words with a separator, not one name. Plain text, not a control: the
            game is switched on the home page. No aria-label: that is not allowed on a generic
            span, and the visible name is the whole message. */}
        <span className="ds-bar-season">
          <span className="sep" aria-hidden="true">·</span>
          {season.name}
        </span>
        <div className="ds-bar-right">
          {/* the header is on EVERY menu screen, so this is the one placement that
              makes queue depth visible everywhere rather than only where someone
              already went looking for a match.

              BOTH of these render nothing until the presence poll lands, and the
              cluster is `margin-left: auto` — so without a reserved box the whole
              right-hand side of the bar re-flows a second after every page load.
              `.ds-bar-live` owns that reservation. `shiftaudit` forces hover and
              state classes but never an async fetch, so it cannot catch this. */}
          <span className="ds-bar-live">
            <QueueCounts className="bar" allGames />
            {presence && <PresenceChip p={presence} />}
          </span>
          {!inActivity && right}
        </div>
      </header>
      {/* the maintenance window, on every menu screen. Fed by the presence poll
          rather than the socket so it also reaches the screens that hold no
          connection — which is exactly where somebody stands when they are about to
          start the thing we need them not to start. */}
      <MaintenanceBanner presence={presence} />
      {/* "LAN game · address · not ranked", whenever this device is pointed at a self-hosted
          server. On the SHELL screens specifically, which is where the misunderstanding
          would actually happen: somebody looking at a leaderboard and wondering why the
          match they just played is not on it. The room screens replace this shell outright
          and say it their own way (`.ds-room-layout` is a 100dvh flex box — a strip above
          it would push the room off the bottom of the viewport). */}
      {lanOn && <LanBanner />}

      {showRail ? (
        <div className="ds-body">
          <NavRail active={active} onNav={onNav} showAdmin={showAdmin} />
          <main className="ds-main">
            {children}
            {/* The SAFE ad inventory: a shell page is not a gameplay page, so
                there is no clearance rule and no frame budget to protect. It
                sits BELOW the page content, after the thing the visitor came
                for — an ad above the leaderboard would be the interstitial
                pattern AdSense's own policies discourage. */}
            <MenuAd />
          </main>
          <FriendsPanel
            signedIn={signedIn}
            onOpenProfile={onOpenProfile}
            onJoinInvite={onJoinInvite}
            onSpectate={onSpectate}
            myUserId={myUserId}
          />
        </div>
      ) : (
        // The home screen deliberately gets NO ad. It is the first thing a new
        // visitor sees and the page an AdSense reviewer lands on; it should read
        // as a product, not as inventory.
        <main className="ds-main ds-main-home">{children}</main>
      )}

      {/* floating friend-request / challenge notifications — menu shell only, so
          they never appear over a live match (full-screen surfaces are outside
          this shell). Inside the FriendsProvider that wraps AppShell in App. */}
      <FriendToasts onOpenProfile={onOpenProfile} onJoinInvite={onJoinInvite} />

      <footer className="ds-foot">
        <span className="ds-foot-brand">
          {APP_NAME}
          {/* the app's presenting sponsor, on EVERY shell screen. The home menu
              announces it; this is the standing credit that makes "presented by"
              a property of the product rather than of its landing page. */}
          <SponsorFooterMark />
        </span>
        <span className="ds-foot-links">
          {/* TWO GROUPS, by position and weight: the product's own destinations at the
              link weight, then the legal set small and muted (design review 11-19). The
              consent link's label ("Data") is fixed by the privacy policy, which names it verbatim
              (legalText.ts), and outside the EEA/UK/CH it lands on the same page as Privacy
              — so the two sit together at the legal weight instead of reading as six peers.
              No `.bold` on any of them: within a group they are peers. No Discord link
              here: the home page carries it. Each group is its own element, so a phone can
              give each one its own row instead of breaking wherever the width runs out. */}
          <span className="ds-foot-group">
            <FootLink href={`/${game}/download`} go={onDownload}>
              Download
            </FootLink>
            <FootLink href={`/${game}/contributors`} go={onContributors}>
              Contributors
            </FootLink>
            {/* hidden until the tier is actually open for business - see
                SUPPORT_ENABLED. A link to a page that cannot take a payment is a
                dead end, and a broken purchase path is a cited AdSense rejection. */}
            {SUPPORT_ENABLED && (
              <FootLink href={`/${game}/donate`} go={onDonate}>
                Support
              </FootLink>
            )}
            <FootLink href={`/${game}/changelogs`} go={onChangelog}>
              Changes
            </FootLink>
          </span>
          <span className="ds-foot-group">
            <FootLink href={`/${game}/privacy`} go={onPrivacy} legal>
              Privacy
            </FootLink>
            <ConsentLink onPrivacy={onPrivacy} />
            <FootLink href={`/${game}/terms`} go={onTerms} legal>
              Terms
            </FootLink>
          </span>
        </span>
      </footer>
    </div>
    </PresenceProvider>
  );
}

/**
 * A footer DESTINATION: a real `<a href>` so it works without JS (Legal.tsx needs the policy
 * reachable that way), is crawlable, and opens in a new tab on middle/modifier click. A plain
 * left click stays in the SPA through the app's own `navigate` (`go`). The hrefs mirror
 * `screenSuffix` in App.tsx, which the router's `parseScreen` reads back.
 *
 * The click also puts the page back at its TOP (owner, 2026-09-23). `.ds-app` is the scroll
 * container, not the window (html/body are overflow:hidden for the game canvas), and a
 * navigation that keeps this shell mounted keeps its scroll offset — so the destination opened
 * already scrolled down to where the footer was. Synchronous is fine: the offset belongs to the
 * container, which either survives the navigation (and stays at 0) or is replaced by a fresh one.
 */
function FootLink({
  href,
  go,
  legal,
  children,
}: {
  href: string;
  go: () => void;
  /** the small, muted legal group at the end of the row */
  legal?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      className={legal ? 'ds-foot-link legal' : 'ds-foot-link'}
      href={href}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        go();
        e.currentTarget.closest('.ds-app')?.scrollTo({ top: 0 });
      }}
    >
      {children}
    </a>
  );
}

/**
 * "Data" — reopens the consent message, or explains why it cannot. It was labelled
 * "Privacy & cookie settings" until 2026-09-23 (owner); the policy names it by its label
 * (legalText.ts), so the two change together.
 *
 * Required rather than a nicety: consent that cannot be withdrawn as easily as it was given is
 * not valid consent, and the privacy policy points at this exact link BY NAME, so it has to
 * exist wherever that policy is served.
 *
 * ⚠️ IT USED TO DELETE ITSELF, and that was the bug this is the fix for. `showConsentSettings()`
 * answers false whenever Funding Choices has no revocation entry — which is not an edge case, it
 * is the NORMAL case everywhere outside the EEA, the UK and Switzerland — so the link vanished
 * on first click for most of the world, from a footer whose own privacy policy promises it is
 * there. "A footer link that silently does nothing is worse than no link" was the right
 * premise and the wrong conclusion: the fix is for the link to LEAD somewhere, not to stop
 * existing.
 *
 * So the fallback is the privacy page's "Your data" panel, which carries the same controls plus
 * the sentence saying why no dialog opened (`CONSENT_UNAVAILABLE`). It renders whether or not
 * this build ships a CMP at all, because the panel behind it is useful either way — it is where
 * the analytics switch, the storage inventory, the export and the delete live.
 *
 * The scroll is DEFERRED because `onPrivacy` navigates by React state — the heading does not
 * exist yet when this handler runs — and on the privacy page itself, where navigating is a
 * no-op, the jump is the only feedback there is.
 *
 * ⚠️ `setTimeout` AND NOT `requestAnimationFrame`. rAF does not fire in a hidden or backgrounded
 * tab, so the version that used it scrolled nowhere whenever the page was not being painted —
 * which is exactly the state a tab is in while something else is in front of it. A frame
 * callback is the right tool for "before the next paint" and the wrong one for "after React has
 * committed", which is all this needs.
 */
function ConsentLink({ onPrivacy }: { onPrivacy: () => void }) {
  return (
    <button
      className="ds-foot-link legal"
      onClick={() => {
        if (showConsentSettings()) return;
        onPrivacy();
        setTimeout(() => {
          document.getElementById('your-data')?.scrollIntoView({ block: 'start' });
        }, 0);
      }}
    >
      Data
    </button>
  );
}
