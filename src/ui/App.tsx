import { lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useDialog } from './useDialog';
import type { GameSettings } from '../game';
import { hasStoredSettings, loadSettings, saveSettings, switchGame, syncAudioMirrors } from '../settings';
import {
  saveAccountSettings,
  fetchAdminStatus,
  fetchProfile,
  fetchFriends,
  dismissRoomInvite,
  type Activity,
  type RoomInvite,
} from '../net/api';
import { uploadPracticeRun, uploadLanRun, reportPlayed, type LanParticipant } from '../net/api';
import { tabHosting } from '../lan/hosting';
import { GAME_IDS } from '../games/types';
import { devRoutesEnabled, gameVisible } from '../seasonVisibility';
import { moduleFor } from '../games';
import { preloadRoomPhysics } from '../net/roomPhysics';
import { FriendsProvider } from './friendsContext';
import { challengeOf, type PendingChallenge } from './challenge';
import type { RoomConfig, RoomKind } from '../net/protocol';
import { useNewVersion } from '../net/version';
import { useServerNotice } from '../net/notice';
/**
 * THE WHOLE ADMIN CONSOLE IS A LAZY CHUNK, and this import is the split point.
 *
 * `Admin` statically pulls in `AdminLive`, `AdminReports`, `AdminAudit`, `AdminUser`,
 * `AdminStanding`, `adminBits` and `adminCopy`. Imported eagerly, every one of them shipped in
 * the chunk a PLAYER downloads to drive a robot — a route exactly one account on the service can
 * reach. `npm run bundleaudit` ratchets `main`, and the console is the fastest-growing thing in
 * it. Splitting HERE rather than per panel is what makes it one boundary instead of seven, and
 * it takes `AdminAnalytics`'s own `lazy()` with it as a nested chunk.
 */
const Admin = lazy(() => import('./Admin').then((m) => ({ default: m.Admin })));
import { Announcements } from './Announcements';
import { AccountReset } from './AccountReset';
import { AccountSync } from './AccountSync';
import { AccountVerify } from './AccountVerify';
import { EMAIL_VERIFIED_EVENT } from './VerifyCodeForm';
import { GameView } from './GameView';
import { Lobby } from './Lobby';
import { WatchLive } from './WatchLive';
import { LobbyClient } from '../net/lobbyClient';
import { AppShell, type ShellNav } from './AppShell';
import { HomeMenu } from './HomeMenu';
import {
  inDiscordActivity,
  discordInstanceId,
  discordGroup,
  roomCodeForInstance,
  watchDiscordParticipants,
  type DiscordParticipant,
} from '../net/discordActivity';
import { DiscordLobbyList } from './DiscordLobbyList';
import { ModeSelect } from './ModeSelect';
import { LanPanel } from './LanPanel';
import { Configure, isConfigureSection, type ConfigureSection } from './Configure';
import { Records, isRecordsTab, type RecordsTab } from './Records';
import { RecordRun } from './RecordRun';
import { Matchmaking } from './Matchmaking';
import { QueueBar, useParkedQueue } from './QueueBar';
import { usePresence } from './usePresence';
import { maintenanceLine } from './MaintenanceBanner';
import { dropQueue, peekQueue } from './queueKeeper';
import { ReplayView } from './ReplayView';
import { ProfileMenu } from './ProfileMenu';
import { Download } from './Download';
import { Contributors } from './Contributors';
import { Privacy, Terms } from './Legal';
import { Donate } from './Donate';
import { Changelog } from './Changelog';
import { Profile } from './Profile';
import { TermsGate } from './TermsGate';
import { UsernameGate } from './UsernameGate';
import { Account } from './Account';
import { Appearance } from './Appearance';
import { RewardDialog } from './RewardDialog';
import type { ProfileTab } from './ProfileTabs';
import { authEnabled } from '../lib/authClient';
import { useLanEnabled } from './useLanEnabled';
import { lanEnabled, gameServerConfigured, lanActive, setSelectedServer, selectedServer, selectedServerId, gameServerUrlWith } from '../net/env';
import { roomJoinRegion } from '../net/roomRegion';
import { ServerMenu } from './ServerMenu';
import type { MatchResultInfo, NetSession } from '../net/session';
import { ServerSession } from '../net/serverSession';
import { WebSocketTransport } from '../net/transport';
import { CLIENT_CAPS, encodeMsg } from '../net/protocol';
import { loadActiveGame, saveActiveGame, clearActiveGame, type ActiveGameRef } from '../net/activeGame';
import { loadStagedMatch } from '../net/stagedMatch';
import type { ResumedRoom } from './roomReturn';
import { recordScore, type Replay, type ReplayResult } from '../sim/replay';
import {
  savePracticeRun,
  markPracticeUploaded,
  pendingPracticeUploads,
  loadPracticeReplay,
} from '../net/practiceRuns';
import {
  saveLanRunLocal,
  markLanUploaded,
  markLanRefused,
  pendingLanUploads,
  loadLanReplay,
} from '../net/lanRuns';
import { applyRouteMeta } from '../seo';
import { trackPageview } from '../pageviews';
import type { GameId } from '../games/types';
import { chainDisclaimerSeen, markChainDisclaimerSeen } from '../chainDisclaimer';
import { startSelectionLegal } from './startPositions';
import { setPadNavPrefs } from '../input/padNav';
import { LoadBoundary } from './LoadBoundary';
import { setViewBindings } from '../games/biobuzz/graphics/viewKey';

type Screen =
  | 'home'
  | 'modes'
  | 'configure'
  | 'records'
  | 'lobby'
  | 'discordlobbies'
  | 'record'
  | 'duorecord'
  | 'matchmaking'
  | 'watch'
  | 'lan'
  | 'replay'
  | 'game'
  | 'download'
  | 'contributors'
  | 'privacy'
  | 'terms'
  | 'donate'
  | 'changelogs'
  | 'profile'
  | 'account'
  /** `/account/reset` and `/account/verify` — the two screens an auth email lands
   *  on. Separate screens rather than a `sub` of `account`, because neither is a tab
   *  of the Profile page: they are reached once, from a link, by someone who may not
   *  be signed in at all. */
  | 'accountreset'
  | 'accountverify'
  | 'admin'
  /** a game's own alpha-only dev route (`GameModule.devRoutes`) */
  | 'dev';

/** everything a route needs beyond the screen itself */
interface RouteArgs {
  /** `/replay/<id>` */
  replayId: string | null;
  /** `/profile/<username>` */
  username: string | null;
  /** the section/tab of a screen that has them: `/configure/<sub>`, `/records/<sub>` */
  sub: string | null;
  /** the matched `GameDevRoute.path` for `screen === 'dev'` */
  dev: string | null;
}
const NO_ARGS: RouteArgs = { replayId: null, username: null, sub: null, dev: null };

/**
 * Tiny path router (no dependency). Each screen is a real URL, and every URL is
 * PREFIXED by the selected game — /decode/modes, /chain/configure/robot,
 * /chain/records/career, … — via the History API, so links are shareable, the
 * game is always visible in the address bar, and back/forward switch both the
 * screen AND the game. DECODE and Chain Reaction never share a URL. The web build
 * uses an absolute base + a vercel.json SPA rewrite so a deep load/refresh
 * resolves. Under Electron (file://) there is no History to push, so we route by
 * state only (isWebHistory === false).
 *
 * Back-compat: an OLD unprefixed link (/modes, /leaderboard) still resolves — the
 * game falls back to the last-selected game and the URL is canonicalized to
 * include the prefix on load.
 */
const isWebHistory = typeof window !== 'undefined' && window.location.protocol !== 'file:';

/**
 * The `/decode`, `/chain`, … URL prefix, BUILT FROM `GAME_IDS` rather than written
 * out — it was a hand-typed `(decode|chain)` in two places, so a new game got no
 * route at all and its deep links silently rendered the saved game's screen.
 * Every id is a plain lowercase word, so nothing here needs escaping.
 */
const GAME_PREFIX_RE = new RegExp(`^/(${GAME_IDS.join('|')})(?=/|$)`);

/**
 * Did this document OPEN on a game-prefixed URL? Captured at module load, before
 * the mount effect canonicalizes `/` to `/decode` in the address bar.
 *
 * It decides the home route's canonical. `/` and `/decode` render the same
 * screen, so one has to point at the other, and which one depends on the URL
 * that was actually requested: arrive at `/` and the canonical is `/`, arrive at
 * `/decode` and it is `/decode`. Reading `location.pathname` from the effect
 * can't tell the two apart (the rewrite has already run), so every visit would
 * canonicalize to `/decode` and quietly deindex the homepage.
 *
 * A crawler renders exactly one URL and never navigates, so a value fixed at
 * load is right for the only consumer that reads canonicals; in-app navigation
 * back to home just keeps whichever form the tab was opened with.
 */
const ENTRY_HAS_GAME = isWebHistory && GAME_PREFIX_RE.test(window.location.pathname);

/** the screen part of a path (no game prefix); '' for home. */
function screenSuffix(screen: Screen, a: RouteArgs): string {
  switch (screen) {
    case 'home':
      return '';
    case 'modes':
      return '/modes';
    case 'configure':
      return `/configure/${isConfigureSection(a.sub) ? a.sub : 'robot'}`;
    case 'records':
      return a.sub === 'career' ? '/records/career' : '/records';
    case 'profile':
      return a.username ? `/profile/${encodeURIComponent(a.username)}` : '/records';
    case 'lobby':
      return '/lobby';
    case 'discordlobbies':
      return '/discord-lobbies';
    case 'record':
      return '/record';
    case 'duorecord':
      return '/duo-record';
    case 'matchmaking':
      return '/ranked';
    case 'watch':
      return '/watch';
    case 'lan':
      return '/lan';
    case 'replay':
      return a.replayId ? `/replay/${encodeURIComponent(a.replayId)}` : '/replay';
    case 'game':
      return '/play';
    case 'download':
      return '/download';
    case 'contributors':
      return '/contributors';
    case 'privacy':
      return '/privacy';
    case 'terms':
      return '/terms';
    case 'donate':
      return '/donate';
    case 'changelogs':
      return '/changelogs';
    case 'account':
      // the Profile destination's two pages — `/account` is the ACCOUNT page and stays so,
      // because it is a shipped URL with jobs of its own (see `ProfileTabs`)
      return a.sub === 'appearance' ? '/account/appearance' : '/account';
    case 'accountreset':
      return '/account/reset';
    case 'accountverify':
      return '/account/verify';
    case 'admin':
      return '/admin';
    case 'dev':
      return a.dev ?? '';
  }
}

/** the full path for a screen under a given game — always game-prefixed. */
function pathFor(screen: Screen, a: RouteArgs, game: GameId): string {
  return `/${game}${screenSuffix(screen, a)}`;
}

/** parse the screen (no game prefix) from a game-stripped path. */
function parseScreen(rest: string): { screen: Screen } & RouteArgs {
  const at = (screen: Screen, extra: Partial<RouteArgs> = {}) => ({
    screen,
    ...NO_ARGS,
    ...extra,
  });

  const replay = rest.match(/^\/replay\/(.+)$/);
  if (replay) return at('replay', { replayId: decodeURIComponent(replay[1]) });
  const profile = rest.match(/^\/profile\/(.+)$/);
  if (profile) return at('profile', { username: decodeURIComponent(profile[1]) });

  const configure = rest.match(/^\/configure(?:\/([^/]+))?/);
  if (configure) return at('configure', { sub: configure[1] ?? 'robot' });
  const records = rest.match(/^\/records(?:\/([^/]+))?/);
  if (records) return at('records', { sub: records[1] ?? 'leaderboard' });

  // legacy paths kept alive so old links (and anything a player bookmarked
  // before the nav restructure) still resolve to their new home
  if (rest.startsWith('/my-robot')) return at('configure', { sub: 'robot' });
  if (rest.startsWith('/leaderboard')) return at('records', { sub: 'leaderboard' });
  if (rest.startsWith('/stats')) return at('records', { sub: 'career' });

  if (rest.startsWith('/modes')) return at('modes');
  if (rest.startsWith('/lobby')) return at('lobby');
  /* ⚠️ THE DISCORD LOBBY BROWSER NEEDS A CASE HERE OR IT IS A WRITE-ONLY ROUTE. `screenSuffix`
     pushes `/discord-lobbies` and the canonicalise effect puts it in the address bar, but with
     no arm here the path fell through to `at('home')` — so a RELOAD while browsing lobbies
     landed on home. A reload inside an activity is not hypothetical: it is why the instance id
     is persisted at all (`DISCORD_INSTANCE_KEY`). Gated like `/lan` is, because outside an
     activity the screen has nothing to list. */
  if (inDiscordActivity() && rest.startsWith('/discord-lobbies')) return at('discordlobbies');
  if (rest.startsWith('/duo-record')) return at('duorecord');
  if (rest.startsWith('/record')) return at('record');
  if (rest.startsWith('/ranked')) return at('matchmaking');
  if (rest.startsWith('/watch')) return at('watch');
  // Unresolvable where LAN is held back, so `/lan` falls through to home rather than
  // rendering an empty screen under a "LAN play" title (`src/seo.ts` still carries that
  // entry, correctly — it comes back the moment the flag does).
  if (lanEnabled() && rest.startsWith('/lan')) return at('lan');
  if (rest.startsWith('/download')) return at('download');
  if (rest.startsWith('/contributors')) return at('contributors');
  if (rest.startsWith('/privacy')) return at('privacy');
  if (rest.startsWith('/terms')) return at('terms');
  if (rest.startsWith('/donate')) return at('donate');
  if (rest.startsWith('/changelogs')) return at('changelogs');
  // BEFORE the bare `/account`, which is a prefix of both
  if (rest.startsWith('/account/reset')) return at('accountreset');
  if (rest.startsWith('/account/verify')) return at('accountverify');
  if (rest.startsWith('/account/appearance')) return at('account', { sub: 'appearance' });
  if (rest.startsWith('/account')) return at('account');
  if (rest.startsWith('/admin')) return at('admin');
  // /play (a live game) can't be restored without a session ⇒ home
  return at('home');
}

/**
 * Parse a full URL into the game + screen. A leading game segment (/decode,
 * /chain, …) selects the game; an unprefixed (legacy) path falls back to
 * `fallbackGame`.
 *
 * A prefix for a game HIDDEN on this release channel falls back to
 * `fallbackGame` as well, but keeps its SCREEN: the link is a real link and its
 * `/records` half still means something, so `/biobuzz/records` on a stable build
 * lands on the saved game's records rather than on home. The URL is then
 * canonicalized to the fallback game by the mount effect, so the address bar
 * stops advertising a season this build does not have.
 */
function parsePath(pathname: string, fallbackGame: GameId): { game: GameId; screen: Screen } & RouteArgs {
  const gm = pathname.match(GAME_PREFIX_RE);
  const prefixed = gm ? (gm[1] as GameId) : null;
  const game: GameId = prefixed && gameVisible(prefixed) ? prefixed : fallbackGame;
  const rest = gm ? pathname.slice(gm[0].length) || '/' : pathname;
  // a game's own dev route wins over the shared screen table, but only where the
  // prefix ACTUALLY named that game — an unprefixed legacy path must not pick up
  // the fallback game's instruments
  if (prefixed === game && devRouteFor(game, rest)) return { game, ...NO_ARGS, screen: 'dev', dev: rest };
  return { game, ...parseScreen(rest) };
}

/**
 * The component for one of `game`'s dev routes, or null.
 *
 * The channel gate lives HERE rather than at the render site so a stable build
 * neither routes to one nor renders one: an unmatched path falls straight through
 * to `parseScreen`, which sends an unknown path home.
 *
 * A route path ending in `/*` matches its base AND everything under it, so one
 * entry covers an instrument that routes its own sub-paths. BIOBUZZ's scene
 * gallery is exactly that: 70 scenes, each with its own `/gallery/<id>` URL that
 * the grid links to and a feedback dump pastes, reached through ONE route rather
 * than through 70 entries the scene registry would have to stay in step with.
 * The route's own component reads the remainder off `window.location`.
 */
function devRouteFor(game: GameId, rest: string): ComponentType | null {
  if (!devRoutesEnabled()) return null;
  const routes = moduleFor(game).devRoutes;
  if (!routes) return null;
  for (const r of routes) {
    if (r.path.endsWith('/*')) {
      const base = r.path.slice(0, -2);
      if (rest === base || rest.startsWith(`${base}/`)) return r.Component;
    } else if (r.path === rest) {
      return r.Component;
    }
  }
  return null;
}

/** which rail/menu entry lights up for a given screen */
function navFor(screen: Screen): ShellNav {
  switch (screen) {
    case 'modes':
    case 'game':
    case 'lobby':
    case 'discordlobbies':
    case 'record':
    case 'duorecord':
    case 'matchmaking':
    case 'watch':
    case 'lan':
      return 'play';
    case 'configure':
      return 'configure';
    case 'records':
      return 'records';
    case 'account':
    case 'accountreset':
    case 'accountverify':
      return 'profile';
    case 'admin':
      return 'admin';
    default:
      return 'home';
  }
}

/** the landing route for each top-level destination */
function screenForNav(n: ShellNav): Screen {
  switch (n) {
    case 'home':
      return 'home';
    case 'play':
      return 'modes';
    case 'configure':
      return 'configure';
    case 'records':
      return 'records';
    case 'profile':
      return 'account';
    case 'admin':
      return 'admin';
  }
}

/**
 * ONE SHELL DIALOG over the `.overlay` scrim (design review C07). Every start guard below is
 * one of these, so the dialog semantics live in one place: the PANEL is the dialog (not the
 * scrim), labelled by its visible title, and `useDialog` moves focus in, traps Tab and hands
 * focus back. `onClose` is the SAME handler as the dialog's visible dismiss button; omit it
 * for one that has to be answered, and Escape does nothing.
 */
function OverlayDialog({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
}) {
  const ref = useDialog(onClose);
  const titleId = useId();
  return (
    <div className="overlay">
      <div ref={ref} className="overlay-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 className="ds-dialog-title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** Neon Auth's OAuth return param (`NEON_AUTH_SESSION_VERIFIER_PARAM_NAME` in the SDK, not
 *  exported from its public entry). See the canonicalization effect in `App`. */
const AUTH_VERIFIER_PARAM = 'neon_auth_session_verifier';

export function App() {
  /* Whether the LAN entry points exist at all. Not a build constant any more: the
     server advertises it, so this flips once the shell's first presence poll lands
     (src/net/env.ts). `parseScreen` reads the same value through `lanEnabled()`,
     which is not a component and cannot hold a hook. */
  const lanOn = useLanEnabled();
  // the URL is game-prefixed, so a deep load/refresh onto /chain/... must select
  // that game up front (switchGame swaps in its saved loadout) — do it in the
  // initializer so the very first render is already on the right game.
  const [settings, setSettings] = useState<GameSettings>(() => {
    const stored = loadSettings();
    /**
     * THE DISCORD ACTIVITY OPENS ON BIOBUZZ, and only the activity does.
     *
     * The app-wide default in `defaultSettings()` stays DECODE — the website and the
     * desktop app are unchanged. Inside the embed there is no game-prefixed URL to read a
     * season from, so `settings.game` is the whole story, and the current season is the
     * one a player dropping into a voice channel expects to land on.
     *
     * ⚠️ It seeds a DEFAULT, it does not pin a season. A player who picks another season
     * in the activity has settings stored for that origin from then on, so this stops
     * applying to them — which is why it asks `hasStoredSettings()` rather than testing
     * whether the loaded game happens to equal the default. Those are different questions:
     * somebody who deliberately chose DECODE would be overridden on every launch by the
     * second one.
     *
     * `DiscordLobbyList` is still handed `settings.game` and still says "the season picked
     * on the home page", both of which stay true — this only changes what that value
     * STARTS as, so there is no second source of truth for the season.
     */
    const s =
      inDiscordActivity() && !hasStoredSettings() ? switchGame(stored, 'biobuzz') : stored;
    // a SAVED game hidden on this channel is dropped as well, not just a hidden
    // URL prefix: `coerceSettings` validates `game` as a `GameId` and knows
    // nothing about channels, so a stored `biobuzz` from an alpha build (the same
    // origin under Electron, or a preview deploy) would open a stable build
    // straight onto a season it must not name. Measured before the guard: the
    // home eyebrow read "BIOBUZZ presented by RTX" and the URL canonicalized to
    // /biobuzz, on a build whose picker does not list it.
    const visible = gameVisible(s.game) ? s : switchGame(s, 'decode');
    if (isWebHistory) {
      const g = parsePath(window.location.pathname, visible.game).game;
      if (g !== visible.game) return switchGame(visible, g);
    }
    return visible;
  });
  const start = isWebHistory
    ? parsePath(window.location.pathname, settings.game)
    : { screen: 'home' as Screen, game: settings.game, ...NO_ARGS };
  /**
   * A PAGE LOAD WITH A RANKED MATCH STILL WAITING GOES STRAIGHT TO IT.
   *
   * `stagedMatch` is only ever written between the assignment and the first tick, and it
   * expires with the server clocks that bound that window — so if it is here and fresh,
   * there is a room holding this account's seat right now and the alternative to going
   * back to it is a dodge. The matchmaking screen adopts it on mount.
   *
   * It overrides the URL rather than deferring to it, and that is the point: the URL a
   * reload restores is whatever screen the player was on, and none of them is the one
   * with twenty seconds left on it. The path is rewritten to match below (the canonical
   * -path effect reads `screen`), so the address bar does not lie about where they are.
   */
  const startScreen: Screen = loadStagedMatch() ? 'matchmaking' : start.screen;
  const [screen, setScreen] = useState<Screen>(startScreen);
  const [route, setRoute] = useState<RouteArgs>(start);
  const [session, setSession] = useState<NetSession | null>(null);
  // read by the match-found takeover, which must fire on `found` alone — depending on
  // `screen`/`session` directly would re-run it on every navigation instead
  const sessionRef = useRef<NetSession | null>(null);
  const screenRef = useRef<Screen>('home');
  /** the session `rejoinGame` is still waiting to show (see its guard); null when none is */
  const rejoiningRef = useRef<ServerSession | null>(null);
  // which flow opened the live session — only 'record' offers an in-game NEW RUN
  const [sessionKind, setSessionKind] = useState<ActiveGameRef['kind'] | null>(null);
  /**
   * Is the live session a CO-OP (duo record) run?
   *
   * Kept apart from `sessionKind`, which is 'record' for both solo and duo — and
   * the two want opposite things from the restart control. A solo run tears itself
   * down and opens a fresh room; a duo run belongs to BOTH drivers, so restarting
   * is a vote and one player must never be able to take it away from the other. Duo
   * previously fell through to the solo path, which sent the presser off to a SOLO
   * record screen and left their partner alone in the run.
   */
  const [sessionCoop, setSessionCoop] = useState(false);
  // a just-played replay to watch in-memory (not yet persisted, so no URL id)
  const [replayObj, setReplayObj] = useState<Replay | null>(null);
  // which robot the WATCHER drove in that replay, so the viewer puts them behind
  // their own driver station instead of whichever alliance is first on the roster
  // (the camera flips a full 180° between alliances — see `replayViewpoint`).
  const [replayRobot, setReplayRobot] = useState<number | null>(null);
  /**
   * The MATCH a replay opened from a moderation surface belongs to, so the viewer can offer
   * the score editor beside it.
   *
   * In-memory state rather than a route argument, deliberately, and it is the same shape
   * `replayObj` uses: a replay URL is shareable and a match id in it would be an invitation
   * to anyone who has the link. This only ever comes from the admin panel, in this tab, this
   * session — and the server re-checks the admin gate on every call regardless, so the worst
   * a forged one could do is show a moderator's panel to somebody the API then refuses.
   */
  const [replayMatch, setReplayMatch] = useState<string | null>(null);
  // one-time "this simulation isn't realistic" disclaimer (shown the first time the Play
  // screen opens with CR selected, on this device; dismissal persists in localStorage)
  const [showChainDisclaimer, setShowChainDisclaimer] = useState(false);
  const dismissChainDisclaimer = (): void => {
    markChainDisclaimerSeen();
    setShowChainDisclaimer(false);
  };
  /** an announcement is on screen — the claim dialog waits for it rather than stacking */
  const [annActive, setAnnActive] = useState(false);
  // launched from Controls: enter Free Drive with the mobile-layout editor already open
  const [editMobileLayout, setEditMobileLayout] = useState(false);

  // kept current every render so the []-deps effects (popstate) read live settings
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // the 3D view keys listen outside React (`graphics/viewKey.ts`), so they are handed the binds
  useEffect(() => setViewBindings(settings.bindings.keys), [settings.bindings]);

  // on first load, persist the possibly-URL-switched game and canonicalize the URL
  // so an old unprefixed / cross-game link becomes a proper /<game>/... path.
  useEffect(() => {
    if (!isWebHistory) return;
    saveSettings(settingsRef.current);
    // `startScreen`, not `start.screen` — a staged ranked match overrides the restored
    // URL (see above), and the address bar has to say where the player actually is
    const canonical = pathFor(startScreen, start, settingsRef.current.game);
    // ⚠️ COMPARE THE SEARCH TOO, not just the pathname. `pathFor` never emits a query,
    // so anything in one is consumed-and-finished — including the `?token=` a reset or
    // verification link arrives with. Comparing pathnames alone meant a token sitting on
    // an ALREADY-canonical path was never stripped: it stayed in the address bar, in the
    // history entry, and in anything that reads `location.href` (a copied link, a
    // referrer, an analytics beacon). Stripping it here is safe because `entryToken.ts`
    // captured it at MODULE LOAD, which is exactly why that file exists.
    // ⚠️ KEEP THE FRAGMENT. `pathFor` emits neither a query nor a hash, so replacing the URL
    // with it alone DELETED the hash — and the admin console's whole URL state lives there
    // (`#tab=users&user=<id>`, chosen precisely because App owns the path and the query). The
    // unprefixed `/admin` canonicalizes to `/decode/admin`, which is not equal, so EVERY
    // pasted console link was rewritten to a bare path before `Admin` mounted and opened on
    // Live. The query still goes: `?token=` is consumed at module load and must not survive.
    // ⚠️ EXCEPT THE GOOGLE SIGN-IN VERIFIER. Neon Auth returns from Google to this page with
    // `?neon_auth_session_verifier=…`, and the SDK trades it for the session when its first
    // `get-session` request STARTS, reading `location.search` at that moment, then deletes the
    // param itself. This effect used to strip it first on some loads (it is a race with the
    // session fetch), and the player landed back signed out. Someone already signed in to Google
    // never sees Google's page, so it looked like "Sign in with Google just reloads the page".
    const verifier = new URLSearchParams(window.location.search).get(AUTH_VERIFIER_PARAM);
    const target = verifier
      ? `${canonical}?${new URLSearchParams({ [AUTH_VERIFIER_PARAM]: verifier })}`
      : canonical;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState(null, '', target + window.location.hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reflect back/forward into state (no push — the URL already changed). A game
  // prefix change (…/decode/… ↔ …/chain/…) swaps the game too.
  useEffect(() => {
    if (!isWebHistory) return;
    const onPop = (): void => {
      const cur = settingsRef.current;
      const s = parsePath(window.location.pathname, cur.game);
      if (s.game !== cur.game) {
        const ns = switchGame(cur, s.game);
        setSettings(ns);
        saveSettings(ns);
      }
      setScreen(s.screen);
      setRoute({ replayId: s.replayId, username: s.username, sub: s.sub, dev: s.dev });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // keep <title>/description/canonical/og:url pointed at the CURRENT route. The
  // static tags in index.html describe the homepage (all a social scraper ever
  // gets); this is the rendering-crawler + browser-tab half of the same job.
  useEffect(() => {
    const path = pathFor(screen, route, settings.game);
    applyRouteMeta(screen, path, settings.game, ENTRY_HAS_GAME);
    // The page view rides the SAME effect, because it answers the same question this one
    // does — when a route becomes the current one — and a second effect on the same deps
    // would be a second place for that answer to drift. `pathFor` never emits a query string
    // and `trackPageview` scrubs the ids out of what it is given anyway; both halves are in
    // `src/pageviews.ts`, along with every gate that decides whether anything is sent at all.
    trackPageview(path, settings.game);
  }, [screen, route, settings.game]);

  /* Mirror the two pad-nav preferences into the module store the navigation layer reads. The
     layer is mounted beside `<App/>` (main.tsx) and cannot see this state; `setPadNavPrefs` is a
     no-op when neither field moved, so this costs a comparison per render. */
  useEffect(() => {
    setPadNavPrefs(settings.bindings.pad);
  }, [settings.bindings.pad]);

  // surface the one-time Chain Reaction disclaimer on the first PLAY with CR loaded, not on the
  // switch itself (design review 22-06): firing on `settings.game` threw a blocking modal over
  // home before the player had done anything. The Play screen is where a match starts, and the
  // dialog is modal, so it is read before one can.
  useEffect(() => {
    setShowChainDisclaimer(screen === 'modes' && settings.game === 'chain' && !chainDisclaimerSeen());
  }, [screen, settings.game]);

  /** the single way screens change — updates state AND the URL */
  const navigate = (next: Screen, args: Partial<RouteArgs> = {}): void => {
    const a: RouteArgs = { ...NO_ARGS, ...args };
    setScreen(next);
    setRoute(a);
    if (next !== 'replay') {
      setReplayObj(null); // leaving the viewer drops the in-memory replay
      setReplayMatch(null); // ...and the moderation context it may have been opened with
    }
    if (isWebHistory) {
      const path = pathFor(next, a, settingsRef.current.game);
      if (window.location.pathname !== path) window.history.pushState(null, '', path);
    }
  };

  /** open a player's public profile page (/profile/<username>) */
  const openProfile = (username: string): void => navigate('profile', { username });
  /** the rail and the home menu. PROFILE lands on its Appearance page — the "profile" half of
   *  the destination (`ProfileTabs`); the rest map one to one. */
  const goNav = (n: ShellNav): void =>
    n === 'profile' ? navigate('account', { sub: 'appearance' }) : navigate(screenForNav(n));
  const profileTab = (t: ProfileTab): void => navigate('account', t === 'appearance' ? { sub: 'appearance' } : {});
  /** open a replay. `matchId` is passed only from the admin panel, where the match behind the
   *  replay is known and a moderator may need to correct what it scored. */
  const watchReplay = (replayId: string, matchId?: string): void => {
    setReplayMatch(matchId ?? null);
    navigate('replay', { replayId });
  };

  // a friend's room invite, waiting to be auto-joined by the Lobby screen it
  // navigates to. One-shot: Lobby clears it once its mount effect consumes it
  // (see `onAutoJoinConsumed`), so a later NORMAL visit to the same screen never
  // re-triggers the join.
  const [pendingAutoJoin, setPendingAutoJoin] = useState<
    { room: string; config: RoomConfig; region?: string } | null
  >(null);

  // DISCORD ACTIVITY: the home page offers a "Join Discord Lobby" button (with the
  // activity participants' avatars via the Embedded App SDK) that opens a LOBBY
  // BROWSER scoped to this activity — so more than one game can run at once instead
  // of everyone piling into a single four-seat room. `discordGroupId` (the sanitized
  // instance id) is the room GROUP the server lists by; `discordMainCode` is the
  // deterministic "main lobby" code so simultaneous first-joiners still converge on
  // one room. The KIND is pinned (versus); the SEASON is the room's own — the browser
  // reports it per room and the creator's pick for a new one — and is switched to
  // BEFORE the join, exactly as an accepted invite does, because the server refuses a
  // config-mismatched joiner and the Lobby renders the PLAYER's season, not the
  // room's. (Pinned to DECODE, the activity could not play Chain Reaction or BIOBUZZ,
  // and a BIOBUZZ player saw a BIOBUZZ lobby for a DECODE match.) All captured once at
  // mount; `discordInstanceId` also remembers the id for the tab, since the router
  // canonicalizes the launch URL to a bare path and a reload would otherwise lose it.
  const discordGroupId = useMemo(() => (inDiscordActivity() ? discordGroup() : ''), []);
  /**
   * ⚠️ "AM I IN AN ACTIVITY" AND "WHICH PARTY AM I IN" ARE DIFFERENT QUESTIONS, and only one
   * of them can fail.
   *
   * `discordGroupId` needs the INSTANCE ID, which arrives once on the launch URL and is then
   * remembered per tab. With third-party storage blocked (not merely partitioned) a reload
   * inside the activity loses it for good — a fresh document, a bare URL, no storage, and the
   * SDK cannot rescue it because `instanceId` comes from the same stripped query. Gating the
   * EMBED-SHAPED decisions on it therefore turned a blocked-storage reload into a page that
   * re-advertised sign-in and ranked, dropped the region pin, and hid its own Join button —
   * all things that are wrong inside an activity whether or not we know which party it is.
   *
   * So: anything about being EMBEDDED reads `inActivity`, which is host-based and cannot be
   * lost; only the things that genuinely need a party (the lobby browser's scope, the room
   * code) read `discordGroupId`, and they degrade to "no party" rather than to "not embedded".
   */
  const inActivity = useMemo(() => inDiscordActivity(), []);
  const discordMainCode = useMemo(
    () => (discordGroupId ? roomCodeForInstance(discordInstanceId()) : ''),
    [discordGroupId],
  );
  const [discordPeople, setDiscordPeople] = useState<DiscordParticipant[]>([]);
  useEffect(() => {
    if (!discordGroupId) return;
    return watchDiscordParticipants(setDiscordPeople);
  }, [discordGroupId]);
  /**
   * ⚠️ THE ACTIVITY HAS NO SCREEN TO DOWNLOAD BIOBUZZ ON, SO THE DOWNLOAD STARTS AT MOUNT.
   *
   * `preloadRoomPhysics`' own header states the deal: holding a match start on the 3D readiness
   * handshake is only tolerable because the wait is normally zero, and "it is zero exactly when
   * the chunks were fetched while the player was doing something else". On the web that is the
   * Lobby screen — you type a code, and its preload effect has run long before you press start.
   * In the embed the player types nothing: `enterDiscordRoom` auto-joins, so the Lobby's preload
   * and its auto-join run in the same commit and the 1.1 MB fetch starts at the instant the seat
   * does. BIOBUZZ is also the season the activity now OPENS on, so this is the default path, not
   * an edge of it.
   *
   * Both halves, because they are fetched at different doors and only one of them is in the
   * readiness gate: `preloadRoomPhysics` is the Rapier 3D solve the server waits for, and
   * `scene()` is the Three.js renderer, which is first requested at GameView mount — AFTER
   * `matchStart` — and leaves the canvas deliberately blank until it lands. With a 4-second
   * pre-countdown a cold participant could be blind through the opening of AUTO while the room
   * politely waited for the smaller half.
   *
   * Keyed on the season so a pick made inside the activity warms the right chunks, and safe to
   * repeat: `initPhysics3d` resolves the same in-flight promise and a dynamic import is cached.
   * Both are UNAWAITED and both swallow — nothing on screen depends on this, and the room's own
   * gate is where a load that never lands is answered.
   */
  useEffect(() => {
    if (!inActivity) return;
    void preloadRoomPhysics(settings.game).catch(() => {});
    void moduleFor(settings.game)
      .scene?.()
      .catch(() => {});
  }, [inActivity, settings.game]);
  const joinDiscordLobby = (): void => navigate('discordlobbies');
  /** enter a specific Discord room (from the browser) — join-or-create, tagged with
   * the activity group so it shows in everyone else's lobby browser. `game` is the
   * season the room runs; switch to it first so the lobby, the start editor and the
   * robot all belong to the match about to be played. */
  const enterDiscordRoom = (code: string, game: GameId): void => {
    selectGame(game);
    /**
     * OUR OWN SEAT FIRST, A FRESH LOBBY SECOND.
     *
     * Leaving a room that has STARTED A MATCH and coming back was refused outright with
     * "Room is full or a match is already in progress." — reproduced against a real server:
     * leave/rejoin is fine while the room is still a lobby, and refused the moment a match
     * exists, clearing on its own only once the 45s reconnect grace expires (and not at all
     * while somebody else is still playing in there).
     *
     * The server DOES hand a returning player their seat back, but that path is gated on a
     * signed-in account (`if (user)` at the join handler), and the embed cannot sign in
     * because Discord's CSP blocks auth. The web never feels this: its players are usually
     * signed in, and a stuck one just makes a room with a new code. The activity has neither
     * escape — `roomCodeForInstance` is deterministic, so every re-entry targets the one room
     * for the whole voice channel.
     *
     * `rejoin` is the signed-out reclaim the protocol already has: the client id is the proof,
     * because the server minted it and told nobody else. So if this is the room our own saved
     * record names, reclaim the seat; if that is refused (grace expired, match over, seat
     * taken), fall through to the ordinary join rather than a dead end — by then the room has
     * usually recycled into a lobby anyway.
     */
    const freshLobby = (): void => {
      setPendingAutoJoin({ room: code, config: { kind: 'versus', game } });
      navigate('lobby');
    };
    const held = loadActiveGame();
    if (held && held.room.toUpperCase() === code.toUpperCase()) {
      rejoinGame(held, freshLobby);
      return;
    }
    /**
     * ⚠️ EVERYTHING THAT IS NOT THAT RECLAIM GOES THROUGH `guardStart`, and the ORDER is the
     * whole point — this must not be wrapped around the reclaim above.
     *
     * `guardStart`'s first branch blocks on `loadActiveGame()`, which is exactly the record the
     * reclaim is built on, so wrapping the whole function would answer "reclaim my seat in this
     * room" with the "you're already in a game" dialog about that same seat. The reclaim IS the
     * dialog's Rejoin button, taken automatically because the activity knows the room is ours.
     *
     * Every other way into a room is guarded (`onCustomRoom`, `onRanked`, `onRecordRun`, the
     * results screen's Queue again); this one was not, and the server's counterpart is gated on
     * `if (user)`, which the embed can never satisfy. Two guards therefore had NO backstop here:
     *
     *  • ONE LIVE GAME. "Create a separate lobby", and any other row in the browser, joined a
     *    second room while the first seat was still held — so an alliance drove beside a
     *    coasting ghost robot for the whole reconnect grace, nothing ever sent `abandon`, and
     *    `saveActiveGame` then overwrote the single-slot record, losing the pointer the reclaim
     *    above needs. The dialog offers Rejoin or Leave match, and Leave is the frame that
     *    actually releases the seat.
     *  • THE VERSION GATE. `join` carries no `build` (only the ranked queue segregates by one),
     *    so a voice channel left open across a deploy puts mixed builds in one authoritative
     *    room, predicting against different sim constants. `guardStart` is where the refresh
     *    prompt lives.
     *
     * Maintenance and an illegal start pose are also covered by it, and those two the server
     * does refuse on its own — they are a better error, not a missing one.
     */
    guardStart(freshLobby);
  };
  // a name typed on the LAN Play entry card, waiting to seed the Lobby screen it
  // navigates to (`initialName`). One-shot like `pendingAutoJoin` above: cleared on
  // both exits from the Lobby screen it seeds, so a later NORMAL visit shows the
  // ordinary displayName/teamName default instead of a stale LAN-screen name.
  const [pendingLanName, setPendingLanName] = useState<string | null>(null);
  // a RATED challenge waiting to be queued under its party token. Same one-shot
  // shape as pendingAutoJoin and for the same reason: the Matchmaking screen
  // consumes it on mount, so a later ordinary visit to /ranked is an ordinary
  // ranked queue rather than a resurrected challenge.
  const [pendingChallenge, setPendingChallenge] = useState<PendingChallenge | null>(null);
  const startChallenge = (c: PendingChallenge): void => {
    // A challenge names its own GAME, and the recipient accepts it from wherever
    // they already were — which is not necessarily the same game. Switch before
    // queueing: the matchmaker buckets by game, so a challenge queued under the
    // wrong one can never pair with its other half, and the pair simply waits for
    // each other until they give up.
    selectGame(c.game);
    setPendingChallenge(c);
    navigate('matchmaking');
  };

  /**
   * ACCEPT a challenge. The two rated formats have no room to join — they resolve
   * through the matchmaker — so this is the fork between "open a lobby" and "go
   * wait in the ranked queue under this token". `challengeOf` owns that decision,
   * so the sender's path and this one can't drift into disagreeing about what a
   * format means.
   */
  const onJoinInvite = (invite: RoomInvite): void => {
    // Accepting CONSUMES the challenge. The server also clears it once we actually
    // join the room (or, for a rated format, once the matchmaker stages the match
    // this token produced) — that half covers every client, including one that
    // predates this call — but doing it here too means OUR OWN friends list stops
    // showing "waiting to accept" the moment we act on it, rather than after the
    // next poll finds the server already agrees. Fire-and-forget: a failed dismiss
    // here just leaves the row for the server-side clear (or its TTL) to catch.
    void dismissRoomInvite(invite.id).catch(() => {});
    const challenge = challengeOf(invite, invite.from.username ?? invite.from.handle ?? '');
    if (challenge) {
      startChallenge(challenge);
      return;
    }
    // Same rule as a rated challenge: the INVITE names the game, and accepting it
    // from the other one would leave the app configured for a game the room isn't
    // playing — right room, wrong robot, wrong field.
    selectGame(invite.game);
    const config: RoomConfig = { kind: invite.kind, game: invite.game };
    if (invite.kind === 'record' && invite.record) config.record = invite.record;
    // GO WHERE THE ROOM IS. A custom code is bare, so a socket opened without the host's
    // region lands on whichever machine is nearest to US — and if the two of us picked
    // different servers, that machine has no such room and cheerfully makes an empty one
    // with the same code. Older invites carry no region and fall back to the old behaviour.
    setPendingAutoJoin({ room: invite.room, config, region: invite.region ?? undefined });
    navigate(invite.kind === 'record' ? 'duorecord' : 'lobby');
  };

  // "Challenge a friend": the invite has already gone out (FriendsProvider) — drop
  // the challenger into the freshly-created room as host, waiting for them to join.
  // Same one-shot pendingAutoJoin the invite-recipient path uses. `kind` picks the
  // destination: a `record` challenge is a duo co-op run, everything else is a
  // custom versus match — mirroring `onJoinInvite`'s routing for the recipient.
  const hostForChallenge = (code: string, game: GameId, kind: RoomKind): void => {
    // the HOST's own region — the same one stamped on the invite that just went out, so
    // both sides are aimed at one machine by construction rather than by agreement
    const region = selectedServer()?.region || undefined;
    if (kind === 'record') {
      setPendingAutoJoin({ room: code, config: { kind: 'record', record: 'duo', game }, region });
      navigate('duorecord');
    } else {
      setPendingAutoJoin({ room: code, config: { kind: 'versus', game }, region });
      navigate('lobby');
    }
  };

  // when signed in, mirror settings to the account (debounced) as well as local
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
  /** sign-in state for the practice-upload flush, which is async and outlives a render */
  const signedInRef = useRef(false);
  /** one flush at a time — a sign-in and a finished run can land together */
  const flushingPractice = useRef(false);
  /** the same guard for the LAN backlog, which drains on exactly the same two triggers */
  const flushingLan = useRef(false);
  // the account's PUBLIC display name (the mutable `handle` behind leaderboards and
  // /profile), which is NOT `user.name` — that's the immutable Neon Auth sign-up name.
  // Lifted here so the header pill and the Profile page read the same source; before
  // this, the pill showed the stale auth name forever after a rename.
  // `undefined` = not resolved yet (render nothing rather than flashing the auth name,
  // which would show the very bug this fixes on every page load); `null` = no handle set.
  const [handle, setHandle] = useState<string | null | undefined>(undefined);
  // the signed-in account's own username (for Profile to hide friend/block actions
  // on your own page) — fetched alongside `handle`, same call, just also kept.
  const [viewerUsername, setViewerUsername] = useState<string | null>(null);
  // is this account an admin? (server-authorized against ADMIN_USER_IDS) — gates the
  // Admin entry; the server independently enforces every admin action
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!accountUserId) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    fetchAdminStatus().then((s) => {
      if (!cancelled) setIsAdmin(s.isAdmin);
    });
    return () => {
      cancelled = true;
    };
  }, [accountUserId]);

  // load the account's display handle once per sign-in. Kept out of AccountSync's
  // effect on purpose: that one is guarded by a module-level `syncedUser` so settings
  // are fetched at most once per session (it prevents a remount clobbering unsaved
  // edits), and the handle shouldn't inherit that guard's retry semantics.
  useEffect(() => {
    if (!accountUserId) {
      setHandle(undefined);
      setViewerUsername(null);
      return;
    }
    let cancelled = false;
    fetchProfile(accountUserId)
      .then((p) => {
        if (!cancelled) {
          setHandle(p.handle);
          setViewerUsername(p.username);
        }
      })
      // no game server (or it's asleep) — fall back to the auth name in the pill
      .catch(() => {
        if (!cancelled) setHandle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountUserId]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // restore the player's preferred server region (from local settings, or synced
  // from the account once AccountSync applies it) so every connect uses it
  useEffect(() => {
    if (settings.preferredServerId) setSelectedServer(settings.preferredServerId);
  }, [settings.preferredServerId]);

  const update = (next: GameSettings): void => {
    // keep the legacy audio booleans in step with the volume sliders before this
    // blob reaches localStorage or the account (old clients read only those two)
    const s = syncAudioMirrors(next);
    setSettings(s);
    saveSettings(s);
    if (accountUserId) {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveAccountSettings(s), 700);
    }
  };

  /**
   * "EQUIP NOW" ON A COSMETIC — put a claimed decal (or any axis key) on the ACTIVE robot, the
   * same edit the builder's own swatch makes. Settings-side only: the server strips anything
   * the account does not hold at the next join (`stripUnentitledCosmetics`), and the claim
   * that precedes this is what makes the account hold it. Read through `settingsRef` because
   * the dialog's callback outlives the render that created it.
   */
  const equipCosmetic = (id: string): void => {
    const i = id.indexOf(':');
    const axis = id.slice(0, i);
    const key = id.slice(i + 1);
    if (axis !== 'decal' && axis !== 'chassisColor' && axis !== 'accent' && axis !== 'plate') return;
    const cur = settingsRef.current;
    update({ ...cur, spec: { ...cur.spec, [axis]: key } });
  };

  /**
   * Switch the ACTIVE game (and its saved loadout), safely for a caller that is
   * about to `navigate` in the same tick.
   *
   * `settingsRef.current` is assigned BEFORE `update`, because `update` is a
   * setState that will not have landed by the synchronous `navigate` that follows
   * — and `navigate` builds its URL from the ref. Without it the app switched to
   * Chain Reaction while the address bar still read /decode/…, and since the URL is
   * authoritative for the game on load, a refresh from there landed back in the
   * wrong one. Both callers (the parked-queue takeover and an accepted challenge)
   * are exactly that shape.
   */
  const selectGame = (g: GameId): void => {
    const s = settingsRef.current;
    if (s.game === g) return;
    const next = switchGame(s, g);
    settingsRef.current = next;
    update(next);
  };

  const onSyncUser = useCallback((id: string | null) => setAccountUserId(id), []);
  const onSyncLoad = useCallback((s: GameSettings) => {
    // the URL is authoritative for the ACTIVE game — keep the currently-selected
    // game when the account's saved settings load in, so a /chain deep-link isn't
    // reverted to whatever game the account last saved.
    const g = settingsRef.current.game;
    const next = s.game !== g ? switchGame(s, g) : s;
    setSettings(next);
    saveSettings(next);
  }, []);
  const onSyncSeed = useCallback(() => void saveAccountSettings(settingsRef.current), []);

  // the multiplayer game this browser is currently in (persisted to localStorage), so
  // the player can REJOIN it after navigating away and is stopped from starting a 2nd.
  const [activeGame, setActiveGame] = useState<ActiveGameRef | null>(() => loadActiveGame());
  // the server refused to give a saved seat back — the match ended or its grace lapsed.
  // Declared here rather than with the other overlays below because `rejoinGame` sets it.
  const [rejoinGone, setRejoinGone] = useState(false);
  // A backgrounded ranked search that PAIRED. The match will not wait — the server
  // holds the slot for RANKED_JOIN_GRACE_MS and then forfeits it — so this takes the
  // screen back rather than offering a choice, and a solo run in flight is discarded
  // (deliberate: a practice run is worth less than the rated match it would cost).
  const parkedQueue = useParkedQueue();

  /** enter a networked game: remember it (for rejoin + the single-game guard), then
   * show the game screen. Solo play never calls this (it has no session). */
  const beginSession = (s: NetSession, kind: ActiveGameRef['kind'], coop = false): void => {
    if (s.room && s.clientId) {
      const ref: ActiveGameRef = {
        room: s.room,
        region: s.region,
        clientId: s.clientId,
        seatToken: s.seatToken,
        start: {
          seed: s.seed,
          setups: s.setups,
          yourRobotId: s.localRobotId,
          game: s.game,
          // ⚠️ THE ROOM'S PHYSICS, and it has to be here. This object is the handshake a REJOIN
          // rebuilds its whole session from, and it is written out field by field — so a field
          // that is missing is a room the returning client silently plays on the wrong solve.
          // Measured: rejoining a 3D room built a 2D world, predicted a different game from the
          // one the server was scoring, and never latched `physicsPending`.
          physics: s.physics,
          // ⚠️ AND THE MATCH GENERATION, for the same reason and with a worse symptom. The
          // server drops an `input` stamped with a stale generation, so a session rebuilt
          // without this one came back as 0 against a room on 1 and EVERY command was
          // discarded: prediction moved the robot, each snapshot snapped it back, and the
          // returning driver could not move at all. Measured against a local server on
          // 2026-09-19 — 0.000 in of travel without it, 38.7 in with it.
          gen: s.gen,
          ranked: s.ranked,
          intros: s.intros,
          // ⚠️ AND WHO IS IN THE SEATS — the third field to be listed here for the reason the
          // two above it were. The symptom is the mildest of the three (a returning driver's
          // labels fall back to chassis names, so everyone in a room of default builds is
          // labelled the same thing) but the hole is identical: this object is written field by
          // field and a field nobody copies is a field the rejoined session never has.
          drivers: s.drivers,
          region: s.region,
        },
        ranked: s.ranked,
        kind,
        savedAt: Date.now(),
      };
      saveActiveGame(ref);
      setActiveGame(ref);
    }
    setSession(s);
    setSessionKind(kind);
    setSessionCoop(coop);
    navigate('game');
  };

  /** reconnect to and re-enter the match this browser last left (reclaims our held
   * server slot within its reconnect grace; fails cleanly to the "connection lost"
   * panel if the slot is already gone). */
  const rejoinGame = (ref: ActiveGameRef, onGone?: () => void): void => {
    // ⚠️ ONE REJOIN AT A TIME. The wait below lasts up to `REJOIN_SHOW_MS` with the player
    // still on the screen they clicked from, so a second click built a second session, and
    // `setSession` dropped the first one without disposing it: a live socket holding the seat.
    if (rejoiningRef.current) return;
    // the HOST's region if the ref recorded one, ours otherwise — the same rule every other
    // room-opening path uses. A bare code with no hint lands on whichever machine anycast
    // puts nearest to US, which is not where the room we are rejoining lives.
    const region = roomJoinRegion(ref.region, selectedServer()?.region ?? '');
    const params: Record<string, string> = { room: ref.room };
    if (region) params.region = region;
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith(params));
    } catch {
      clearActiveGame();
      setActiveGame(null);
      return;
    }
    // send `rejoin` on the FIRST open (ServerSession only re-sends it on reconnects);
    // the server reattaches our held slot and a snapshot resyncs us
    /**
     * ⚠️ `caps` IS NOT OPTIONAL ON A REJOIN, AND LEAVING IT OFF LOCKED PLAYERS OUT OF 3D ROOMS.
     *
     * The server gates a `'3d'`-physics room on `'bb3d'` at every door it has, and `rejoin` is
     * one of them (`physicsAllowed(r.physics, msg.caps)`). This frame advertised nothing, so a
     * current client returning to its own live 3D match was answered with "Update DSIM to play
     * this room." — measured in a browser on 2026-09-18, and invisible in the smoke suite
     * because the lane tests the SERVER's four doors and this is the client's side of one.
     * The field has existed on the message type since Day 2 for exactly this; nothing sent it.
     */
    transport.onOpen(() =>
      transport.send(
        encodeMsg({ t: 'rejoin', room: ref.room, clientId: ref.clientId, caps: CLIENT_CAPS, seatToken: ref.seatToken }),
      ),
    );
    const s = new ServerSession(transport, false, ref.start, ref.clientId, ref.room, false, ref.seatToken ?? '');
    rejoiningRef.current = s;
    /**
     * A REJOIN THE SERVER REFUSES GOES BACK TO THE MENU, IT DOES NOT PARK ON A DEAD CARD.
     *
     * The record was already forgotten here — otherwise Home offers the same dead match
     * every time it opens — but the player was left on the game screen behind the
     * "connection lost" panel, which is a screen about a connection that is fine. They
     * pressed Rejoin and the answer is that the match is over; say that and put them
     * where they can start another one.
     *
     * ⚠️ ON THE REFUSAL, NOT ON `failed`. `failed` is also how an ordinary mid-match drop
     * ends (the retry budget ran out), and yanking somebody out of a real game they are
     * still in would be much worse than the dead card. `slotRefused` is `rejoined: ok=false`
     * and nothing else. The ref still goes on either, because a match we cannot reach is
     * not one to keep offering.
     */
    /**
     * ⚠️ THE GAME SCREEN OPENS ON AN ANSWER, NOT ON A HOPE.
     *
     * This used to `navigate('game')` on the line after the socket was constructed, so a STALE
     * record — the common case, since a record outlives the match it names — threw the player
     * into the full-screen match view and bounced them out again one round-trip later. On a
     * fresh document that flash is not just cosmetic: mounting `GameView` starts the 3D physics
     * and Three.js fetches and takes a WebGL context, all of it orphaned when the bounce lands.
     * Inside the activity it is the FIRST thing a returning player sees, because JOIN MAIN
     * LOBBY goes through the reclaim above.
     *
     * The proof we wait for is authoritative SNAPSHOTS FLOWING (`snapHz`), which is the one
     * positive signal a refused rejoin can never produce: the server closes the socket on
     * `rejoined: ok=false`. `waitingFor` cannot stand in — a session is born `connected` — and
     * `takeSnapshot` is destructive, so reading it here would steal the first frame from the
     * controller.
     *
     * `REJOIN_SHOW_MS` is the OTHER exit, and it exists so a quiet-but-alive room still opens:
     * snapshots normally begin within a round-trip and `snapHz` lands ~100 ms later, so a
     * second and a half is slack, not a wait anyone sits through. The poll is also what times
     * the refusal, so it is fast enough to be one: at 400 ms it added most of the visible flash.
     */
    const REJOIN_SHOW_MS = 1500;
    const openedAt = Date.now();
    /** the screen the player is standing on while we wait — see `show` */
    const from = screenRef.current;
    let shown = false;
    /** the wait is over: let the next rejoin through (the poll outlives a `show`, see below) */
    const settle = (): void => {
      if (rejoiningRef.current === s) rejoiningRef.current = null;
    };
    const show = (): void => {
      if (shown) return;
      /**
       * SOMETHING ELSE MAY HAVE MOVED THEM FIRST. `setSession` below is immediate (it is what
       * wires `onLobby`), so a room that recycled while we waited answers with `t: 'lobby'`,
       * `backToRoomLobby` takes the player to the room's lobby, and the session is torn down.
       * Navigating to `game` after that renders the match view over a null session.
       */
      if (screenRef.current !== from) {
        /**
         * ⚠️ AND A SESSION NOBODY WILL SHOW IS A SEAT NOBODY IS IN. A player who walked away
         * during the wait was left holding a live socket that kept the seat, behind no screen.
         * Unless the recycle above took it: `backToRoomLobby` released the socket to the lobby
         * (and cleared `rejoiningRef`), and closing it would pull the lobby's connection.
         */
        if (rejoiningRef.current === s) {
          s.dispose();
          if (sessionRef.current === s) {
            setSession(null);
            setSessionKind(null);
            setSessionCoop(false);
          }
        }
        window.clearInterval(watch);
        settle();
        return;
      }
      // ⚠️ CONSUMED ONLY ONCE IT ACTUALLY NAVIGATES. Setting this before the bail above meant
      // a player who moved during the wait disabled `show` for good — and `setSession` has
      // already run, so they were left holding a live session, a live socket and a held seat
      // with no screen showing any of it.
      shown = true;
      settle();
      navigate('game');
    };
    const watch = window.setInterval(() => {
      const st = s.status();
      if (!st.failed) {
        if (st.snapHz !== null || Date.now() - openedAt >= REJOIN_SHOW_MS) show();
        return;
      }
      window.clearInterval(watch);
      settle();
      clearActiveGame();
      setActiveGame(null);
      // an ordinary drop, not a refusal: the player really is in that match, so open it and
      // let the HUD's own "connection lost" panel say so.
      if (!s.slotRefused()) {
        show();
        return;
      }
      setEditMobileLayout(false);
      s.dispose();
      setSession(null);
      setSessionKind(null);
      setSessionCoop(false);
      /**
       * A CALLER THAT HAS SOMEWHERE BETTER TO SEND THEM GETS TO. The Discord Activity
       * does: its room code is deterministic, so a seat it cannot reclaim is a room it
       * can simply walk back into as a fresh lobby — and a match that ENDED while the
       * player was away is exactly that case. Told "that match is over" there, they
       * would be reading a dead end about a room that is open again.
       */
      if (onGone) {
        onGone();
        return;
      }
      setRejoinGone(true);
      navigate('home');
    }, 120);
    window.setTimeout(() => {
      window.clearInterval(watch);
      settle();
    }, 30_000);
    setSession(s);
    setSessionKind(ref.kind);
    // a duo run rejoined has more than one robot on the roster; a solo one does not
    setSessionCoop(ref.kind === 'record' && (ref.start.setups?.length ?? 1) > 1);
  };

  /**
   * SPECTATE a live match read-only. Opens a socket to the room, sends `spectate`,
   * and builds a spectator ServerSession from the `matchStart` the server returns.
   * Never saved as an "active game" (it isn't yours to rejoin).
   *
   * `region` matters for CUSTOM rooms: their codes are bare (no `<region>-` prefix
   * for the proxy to route on), so a socket opened without it lands on whichever
   * machine is nearest to the WATCHER and reports no such room. Callers that
   * already know the host region (the Watch Live cards, a friend's match, the
   * admin list) pass it; the code box looks it up first.
   */
  const spectateRoom = (code: string, region?: string): void => {
    let transport: WebSocketTransport;
    try {
      const r = roomJoinRegion(region, selectedServer()?.region ?? '');
      transport = new WebSocketTransport(
        gameServerUrlWith(r ? { room: code, region: r } : { room: code }),
      );
    } catch {
      return;
    }
    const lobby = new LobbyClient(transport);
    lobby.on('matchStart', (m) => {
      const s = new ServerSession(transport, false, m, lobby.clientId, code, true);
      setSession(s);
      setSessionKind(null); // spectating — no run of our own to restart
      navigate('game');
    });
    lobby.spectate(code);
  };

  /** Controls → "Customize touch controls": drop into Free Drive with the on-screen
   * layout editor already open, so you position controls on the real field. */
  const editTouchControls = (): void => {
    update({ ...settings, mode: 'free' });
    setEditMobileLayout(true);
    navigate('game');
  };

  /**
   * START THE TUTORIAL (roadmap item 6) — from the Modes page's first-run card, or from Controls.
   *
   * `settings` is NOT touched: `GameView` forces free drive for the run itself and leaves the
   * player's Practice setup exactly as they left it. The flag lives in React state rather than in
   * settings, so it does not persist, does not sync to the account, and does not survive a reload
   * onto a screen that has no idea which step was staged.
   *
   * GUARDED like every other way into a run (`guardStart`): a stale build or a scheduled restart
   * blocks a tutorial the same as it blocks a ranked match.
   */
  const startTutorial = (): void =>
    guardStart(() => {
      setTutorialRun(true);
      navigate('game');
    });

  /**
   * A SOLO PRACTICE run finished — keep it.
   *
   * DEVICE FIRST, account second, and the order is the point: solo practice is the primary
   * OFFLINE mode and works signed out, so a run that only survived when an upload succeeded
   * would make the offline mode depend on being online. The local copy is what the player
   * watches; the upload is what follows them to another device.
   *
   * The score stored is the NET one — earned minus the fouls this robot itself committed —
   * because that is what a solo run means everywhere else in the app (`recordScore`), and a
   * practice figure that flattered you relative to a record run would be worse than useless
   * for the one thing practice is for.
   */
  const keepPracticeRun = (replay: Replay, result: ReplayResult): void => {
    const alliance = replay.setups[0]?.alliance ?? 'blue';
    const score = recordScore(result, alliance);
    savePracticeRun(replay, { ...result, score: { ...result.score, [alliance]: score } });
    // the homepage's games-played counter, signed in or not (the upload below is account-only)
    reportPlayed(replay.game ?? 'decode', 'practice');
    // Do not upload THIS run directly — flush the whole backlog instead, which includes it.
    // One path to the server means a run that failed on its own attempt is retried by the
    // next flush rather than being lost, and it is the same code either way.
    void flushPracticeRuns();
  };

  /**
   * Send every practice run the account does not yet have.
   *
   * The upload is the half that can fail, and for reasons that have nothing to do with the
   * run: signed out when it was played, offline, or — routinely, since the game server is a
   * Fly app that auto-stops when idle — a machine still cold-booting when the match ended.
   * So uploading is not a step in finishing a run, it is a backlog that gets drained whenever
   * draining is possible: after a run, and whenever a session appears.
   *
   * SEQUENTIAL, and it STOPS on the first failure. Ten parallel POSTs at a server that is not
   * answering is ten timeouts and no more information than one; the rest keep their place in
   * the backlog for next time.
   */
  const flushPracticeRuns = async (): Promise<void> => {
    if (!signedInRef.current || flushingPractice.current) return;
    flushingPractice.current = true;
    try {
      for (const meta of pendingPracticeUploads()) {
        const replay = loadPracticeReplay(meta.id);
        if (!replay) continue; // body evicted by the local cap — nothing left to send
        const run = await uploadPracticeRun(replay, meta.score, meta.game);
        if (!run) break;
        markPracticeUploaded(meta.id, run.id);
      }
    } finally {
      flushingPractice.current = false;
    }
  };

  /**
   * A SELF-HOSTED (LAN) MATCH FINISHED — keep it, if this device is the one hosting.
   *
   * The owner's rule for this feature is "whoever is hosting the match from the computer",
   * and this is where it is enforced: exactly ONE client in a LAN room keeps and uploads the
   * match. There is no dedup to do on the cloud side because there is only ever one uploader.
   *
   * ⚠️ **A LAN SERVER WRITES NOTHING.** It runs with a blank `DATABASE_URL` by construction
   * (`electron/lanHost.cjs`), so if this client does not keep the match, nothing anywhere
   * does. Device first and account second, exactly like practice — and for a sharper reason:
   * a venue's wifi is at its worst at the final whistle, on a network with forty phones on
   * it, and the host is required to be SIGNED IN but not to be ONLINE.
   *
   * THREE CONDITIONS, and each one is load-bearing:
   *   - `lanActive() || tabHosting()` — the two ways a match can be self-hosted, and BOTH have
   *     to be listed or the newer one silently keeps nothing. `lanActive()` is a room reached
   *     by ADDRESS (the desktop app, `npm run lan`); `tabHosting()` is a room this very tab is
   *     running over WebRTC (`docs/lan-webrtc.md`), which sets no LAN server because there is
   *     no address to set. Neither is true of a CLOUD match, which is written by the server
   *     that ran it — keeping a second copy here would file an unofficial duplicate of an
   *     OFFICIAL match.
   *   - `isHost()` — the one-uploader rule above. A guest and a spectator keep nothing.
   *   - `matchId` — the archive capability, which the room sends to the HOST'S SOCKET ALONE
   *     (`matchArchive`; see the protocol note). A guest never has one, so this condition now
   *     enforces the one-uploader rule a second time and from the server's side rather than
   *     this client's. An older LAN server mints none either, and an unkeyed row would be
   *     re-uploaded as a NEW match on every retry — skipping is the safe half of that trade.
   */
  const keepLanRun = (info: MatchResultInfo, sess: NetSession): void => {
    if ((!lanActive() && !tabHosting()) || !sess.isHost() || !info.matchId) return;
    // NAMES, not account ids. The people in a LAN room are mostly not signed in on this
    // server — it has no accounts at all — so the roster is what the match itself carries.
    // The cloud re-sanitizes every field of this; see `server/api.ts`.
    const participants: LanParticipant[] = sess.setups.map((su) => ({
      name: su.spec.name || `Driver ${su.id}`,
      teamName: su.spec.teamName || undefined,
      teamNumber: su.spec.teamNumber || undefined,
      alliance: su.alliance,
      drivetrain: su.spec.drivetrain,
    }));
    saveLanRunLocal(info.matchId, info.replay, info.result.score, participants);
    // the homepage's games-played counter: a LAN server has no database, so its host counts it
    reportPlayed(info.replay.game ?? 'decode', 'lan', sess.setups.length >= 4 ? '2v2' : '1v1');
    // Same as practice: never upload THIS match directly — drain the backlog, which contains
    // it. One path to the cloud means a failure is retried by the next flush.
    void flushLanRuns();
  };

  /**
   * Send every self-hosted match the account does not yet have.
   *
   * The twin of `flushPracticeRuns`, down to stopping on the first failure — see its note for
   * why sequential. The failure modes are if anything more routine here: a LAN match is played
   * in a gym, and the whole point of the feature is that it works when the internet does not.
   */
  const flushLanRuns = async (): Promise<void> => {
    if (!signedInRef.current || flushingLan.current) return;
    flushingLan.current = true;
    try {
      for (const meta of pendingLanUploads()) {
        const replay = loadLanReplay(meta.id);
        if (!replay) continue; // body evicted by the local cap — nothing left to send
        const run = await uploadLanRun(meta.matchId, replay, meta.score, meta.participants, meta.game);
        // 'refused' is a VERDICT about this match, not about the connection: the cloud already
        // holds this match id under another account, or will never take this body. Retire it
        // and carry on — stopping here would park the whole backlog behind an item that can
        // never drain, and every match played after it would stay on the device forever.
        if (run === 'refused') {
          markLanRefused(meta.id);
          continue;
        }
        if (!run) break;
        markLanUploaded(meta.id, run.id);
      }
    } finally {
      flushingLan.current = false;
    }
  };

  /**
   * Hand the live session its end-of-match callback.
   *
   * ONE registration point for every way a session is made — a lobby room, a record run, a
   * matchmaker assignment, a spectate — which is the reason it lives here rather than beside
   * each `new ServerSession`. `onMatchResult` REPLACES, so re-running this is free.
   *
   * Keyed on the SESSION alone, deliberately: everything the callback reads is either a module
   * function (`lanActive`, the `lanRuns` store) or a ref (`signedInRef`), so there is no
   * render-scoped value to go stale — unlike `onPracticeRun`, which closes over `signedIn`.
   */
  useEffect(() => {
    if (!session) return;
    session.onMatchResult?.((info) => keepLanRun(info, session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** RECORD runs: abandon this run and immediately start a fresh one.
   *
   * Deliberately a full teardown + re-entry, NOT an in-place world rebuild. A
   * record run is hosted on the server, so resetting the world client-side leaves
   * the server running the old match: snapshots snap the world back, reconcile
   * replays stale pre-reset inputs, and the robot fights its own prediction —
   * the stuck/jittery drivetrain this feature was pulled for. Re-entering makes a
   * NEW room, which is the same path a first run takes and carries no such risk.
   * RecordRun connects on mount, so this costs one reconnect, not a menu trip.
   */
  const restartRun = (): void => {
    /**
     * ⚠️ TELL THE SERVER THE OLD RUN IS OVER, AND FORGET IT LOCALLY — both halves used to
     * be missing, and both became visible the moment the single-game lock started actually
     * holding (it was released at match start by `startLoop`'s old `stop()` call, so for
     * months it bound nothing).
     *
     * The server half: the new run is a join on a BRAND-NEW `rec-` code, so the old room's
     * lock is still registered against this account until its own socket close is processed.
     * `abandon` is the same frame the you-have-a-game-in-progress card sends and it needs no
     * reply. It is sent on the LIVE session's socket before it is disposed, so it cannot race
     * the new connection. The server also yields a solo record hold at the door now, so this
     * is belt and braces rather than the only defence — but it is the half that keeps the old
     * room from sitting on a lock it no longer has any use for.
     *
     * The local half: `activeGame` still named the run we are walking away from, so Home went
     * on offering to rejoin a match that no longer exists.
     */
    session?.abandonSlot?.();
    clearActiveGame();
    setActiveGame(null);
    session?.dispose();
    setSession(null);
    setSessionKind(null);
    navigate('record');
  };

  /**
   * TAKEOVER. A parked search paired while the player was elsewhere: pull them onto
   * the matchmaking screen, which adopts the socket and carries on into the
   * pre-match strategy window.
   *
   * It does NOT ask. The server holds the slot for RANKED_JOIN_GRACE_MS and then
   * forfeits it, so a dialog would just be a way to lose the match slowly. Anything
   * in progress is discarded — per the product call, a solo run in flight is worth
   * less than the rated match it would otherwise cost.
   */
  /**
   * Open the matchmaking screen FOR THE PARKED SEARCH, restoring its game first.
   *
   * The parked queue is the authority on which game the match is for, not
   * `settings.game` — the player is free to wander into the other game while
   * waiting, and that is the entire point of parking. Adopting the queue without
   * this switched the app to the CURRENT game: queue Chain Reaction, start a DECODE
   * run, and the takeover came up as DECODE for a Chain Reaction match (wrong
   * ready-up, wrong robot, wrong field). Both ways into the queue screen — the
   * automatic takeover and the bar's View button — go through here.
   */
  const openParkedQueue = (): void => {
    const q = peekQueue();
    if (q) selectGame(q.game);
    navigate('matchmaking');
  };

  useEffect(() => {
    if (!parkedQueue?.found) return;
    // already there: the screen adopts any parked search reactively, not only on mount
    // (`Matchmaking`'s adopt effect), so there is nothing for this to do
    if (screenRef.current === 'matchmaking') return;
    sessionRef.current?.dispose();
    setSession(null);
    setSessionKind(null);
    // ABANDON whatever was in flight, for real. A record run is server-hosted, so
    // it leaves behind a rejoin record AND a held server slot; keeping either would
    // have this ranked match refused as a "second game" by the very guards that
    // exist to stop you starting one. The run is discarded by design here — it is
    // worth less than the rated match it would otherwise cost.
    clearActiveGame();
    setActiveGame(null);
    openParkedQueue();
    // `navigate` and the setters are stable for this component's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parkedQueue?.found]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  /**
   * ---- BACK TO THE ROOM'S OWN LOBBY ----------------------------------------------
   *
   * A custom room used to be worth exactly one game. Everything about the ROOM was frozen
   * at the first start: a rematch replays that roster, so a group that lost a player, or
   * wanted to swap sides, had to mint a new code and all re-join it. The room is now
   * recycled in place instead — the server clears its world and puts it back in the lobby
   * state, keeping every seat.
   *
   * WHICH MEANS THE SOCKET MUST SURVIVE THE SCREEN CHANGE. We hold a seat the server is
   * still counting; closing the connection would give it up and make everyone re-join the
   * room they never left (and lose it outright if it filled in between). So the session
   * `release()`s the transport rather than disposing it, and the Lobby adopts the same
   * connection — the mirror image of the handover `Lobby.handleStart` makes on the way in.
   */
  const [resumedRoom, setResumedRoom] = useState<ResumedRoom | null>(null);

  const backToRoomLobby = (): void => {
    const s = session;
    if (!s?.release || !s.room || !s.clientId) return;
    // a rejoin still waiting on this session no longer owns it: the socket is the lobby's now
    if (rejoiningRef.current === s) rejoiningRef.current = null;
    const transport = s.release();
    setEditMobileLayout(false);
    setSession(null);
    setSessionKind(null);
    setSessionCoop(false);
    // the match is over and the room no longer holds one: there is nothing to rejoin, and
    // leaving the record behind would offer Home a "rejoin your match" that cannot work.
    clearActiveGame();
    setActiveGame(null);
    // ⚠️ THE SEAT'S SECRET TRAVELS WITH THE SOCKET: no `welcome` is re-sent on it, and a lobby
    // that dropped it built the next match's session with an empty token, so every rejoin,
    // Home rejoin card and Abandon was refused for this seat from the room's second match on.
    setResumedRoom({ transport, code: s.room, region: s.region, clientId: s.clientId, seatToken: s.seatToken ?? '' });
    navigate('lobby');
  };

  /**
   * EVERY MEMBER FOLLOWS THE ROOM, not just whoever pressed the button.
   *
   * `requestLobby` only ASKS; the room answers all of its clients at once (`t: 'lobby'`), and
   * that answer is what moves each of them. Driving the screen change off the press instead
   * would leave the rest of the room staring at a results screen for a match the server no
   * longer has — and would move the host even on a request the server refused (a rated room,
   * a result still being written, a member too old to understand the recycle).
   *
   * ⚠️ RE-REGISTERED ON EVERY SESSION, never mount-only: `onLobby` REPLACES, and a callback
   * captured on the first render reads the session that render had. That is the same trap
   * `onPracticeRun` fell into.
   */
  useEffect(() => {
    session?.onLobby?.(() => backToRoomLobby());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** tear the session down without deciding where to go next */
  const leaveSession = (): void => {
    setEditMobileLayout(false);
    /**
     * ⚠️ A SOLO RECORD RUN YOU WALK OUT OF IS OVER, SO STOP OFFERING TO REJOIN IT.
     *
     * `dispose()` is a CLEAN close (1000/1005), and `Room.detach` reaps a solo record room
     * on one rather than holding it for the reconnect grace — the room is gone before the
     * menu has finished rendering. Keeping the record left Home offering a Rejoin that the
     * server answers `rejoined: ok=false` to, which is a button whose only outcome is an
     * error. Every OTHER kind holds its seat for the grace, so their record stays and the
     * offer is real: a custom or ranked match is still there to go back to, and in ranked
     * going back is what stops the away ticks accruing against your standing.
     */
    const soloRecord = sessionKind === 'record' && !sessionCoop;
    if (soloRecord) clearActiveGame();
    session?.dispose();
    setSession(null);
    setSessionKind(null);
    setSessionCoop(false);
    // a match that FINISHED (or whose slot is gone) clears its rejoin record in
    // GameView; a mid-match exit keeps it so Home can offer "rejoin your match".
    setActiveGame(loadActiveGame());
  };

  const exitGame = (): void => {
    leaveSession();
    setTutorialRun(false);
    navigate('home');
  };

  /**
   * Straight from the results screen back into the ranked queue.
   *
   * The alternative was MENU → Play → Ranked, three screens to do the thing most
   * people want after a ranked match. It is the counterpart to REMATCH beside it:
   * that one plays the SAME people again, this one finds new ones.
   *
   * GUARDED FIRST, torn down second. `guardStart` is what stops a new run when a
   * newer build has shipped or maintenance is biting, and if it blocks, the player
   * has to still be on the results screen — leaving the session first would drop
   * them onto a dead one.
   */
  const queueAgain = (): void =>
    guardStart(() => {
      leaveSession();
      navigate('matchmaking');
    });

  // a newer client build shipped while this tab stayed open: prompt to refresh when
  // the player STARTS a run (never mid-run), so they aren't stuck on a stale version
  const newVersion = useNewVersion();
  const [pendingStart, setPendingStart] = useState<(() => void) | null>(null);
  /** the next `/game` mount runs the TUTORIAL (see `startTutorial`), cleared on the way out. */
  const [tutorialRun, setTutorialRun] = useState(false);
  // a scheduled server restart is live (admin notice): don't let anyone START a new
  // game / queue — they'd just get dropped by the restart. People already in a game
  // are untouched (this only guards the start actions). Info notices don't block.
  const notice = useServerNotice();
  // MAINTENANCE LOCKDOWN. The server refuses regardless (that is what makes it a
  // lockdown rather than a suggestion); this stops a player from clicking into an
  // error they could have been told about first. Admins are exempt on both sides.
  const maintenance = usePresence()?.maintenance ?? null;
  const lockedOut = !!maintenance?.biting && !isAdmin;
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [startBlocked, setStartBlocked] = useState(false);
  // set when the player tries to start a new game while one is already in progress —
  // drives the "you have a game in progress" overlay (rejoin or abandon)
  const [blockedByActive, setBlockedByActive] = useState(false);
  // which game it is, so the overlay can name it and say what leaving costs
  const blockedKind = blockedByActive ? (loadActiveGame() ?? activeGame)?.kind : undefined;
  // set when a game start is refused because the active custom start pose is illegal
  // for the current chassis (block-and-warn instead of silently snapping at spawn)
  const [badStart, setBadStart] = useState(false);
  // Guards EVERY game entry — local (free/solo) AND server-provided (record, duo,
  // ranked, custom room). Even though the server snaps an illegal pose legal at
  // spawn, the player configured it for a DIFFERENT chassis, so we refuse to start
  // anywhere and send them to fix it rather than relocating their robot silently.
  const guardStart = (go: () => void): void => {
    /**
     * start-pose legality, per game: DECODE's G304 setup rules / CR's G04 Lab Area.
     *
     * ⚠️ THROUGH `settingsRef`, NOT `settings` — a caller may have just switched season.
     * `enterDiscordRoom` calls `selectGame(game)` on the line above this guard, because the
     * room's season is the room's, and `selectGame` writes the ref before it queues the state
     * update. Read from the render's `settings` instead, the guard would measure the pose of
     * the season the player is LEAVING against that season's rules, and refuse entry to a
     * BIOBUZZ room over a DECODE pose the player is not about to use.
     */
    const cur = settingsRef.current;
    const startOk = startSelectionLegal(cur.game, cur.spec, cur.alliance, cur.startPose);
    if (loadActiveGame()) setBlockedByActive(true);
    else if (lockedOut) setStartBlocked(true);
    else if (restartPending) setStartBlocked(true);
    else if (!startOk) setBadStart(true);
    else if (newVersion) setPendingStart(() => go);
    else go();
  };

  /**
   * ABANDON THE IN-PROGRESS GAME — and say so to the server, which is the half that
   * used to be missing.
   *
   * This only ever cleared the BROWSER's record. That was harmless for as long as the
   * server's single-game lock was inert, and it is not inert any more: the lock is
   * registered when a match begins and released at finalize, drop or stop, so a slot
   * abandoned from the menu went on holding it for the rest of the reconnect grace.
   * The player pressed a button that said the game was gone and the next thing they
   * started was refused — "you already have a game in progress, rejoin or leave it
   * first" — advice about a game the UI had just told them did not exist.
   *
   * One frame on a throwaway socket, and nothing waited on: the local record is
   * dropped either way, because a player who cannot reach the server is not helped by
   * being kept in a room they have left. The socket closes as soon as the frame is out
   * (`abandon` is answered with nothing by design — see the protocol note).
   */
  const abandonActiveGame = (): void => {
    const ref = loadActiveGame();
    if (ref) {
      // the HOST's region if the ref recorded one, ours otherwise — the same rule every
      // other room-opening path uses (see `rejoinGame`).
      const region = roomJoinRegion(ref.region, selectedServer()?.region ?? '');
      const params: Record<string, string> = { room: ref.room };
      if (region) params.region = region;
      try {
        const t = new WebSocketTransport(gameServerUrlWith(params));
        t.onOpen(() => {
          t.send(encodeMsg({ t: 'abandon', room: ref.room, clientId: ref.clientId, seatToken: ref.seatToken }));
          // let the frame leave before the socket does
          window.setTimeout(() => t.close(), 250);
        });
        // never leave a socket dialling forever on a server that is not answering
        window.setTimeout(() => t.close(), 5000);
      } catch {
        /* no reachable server — the local record still goes */
      }
    }
    clearActiveGame();
    setActiveGame(null);
    setBlockedByActive(false);
  };

  const multiplayer = gameServerConfigured();
  // ranked needs a real account (ELO/leaderboard). accountUserId is set by
  // AccountSync on sign-in and stays null when auth is off, so signed-out and
  // no-auth builds both lock ranked — custom rooms stay open to everyone.
  const signedIn = accountUserId !== null;
  /**
   * Sign-in resolves ASYNCHRONOUSLY, and practice runs are kept whether or not anyone was
   * signed in when they were played. So the moment an account appears is exactly when the
   * backlog can move — runs from before the session resolved, from a signed-out session, and
   * from any attempt that hit a cold or unreachable server.
   */
  useEffect(() => {
    const wasSignedIn = signedInRef.current;
    signedInRef.current = signedIn;
    if (signedIn) {
      void flushPracticeRuns();
      // the LAN backlog drains on exactly the same trigger, and for a sharper version of the
      // same reason: a host who signed in after the scrimmage still owns those matches
      void flushLanRuns();
    } else if (wasSignedIn) {
      // SIGNING OUT CANCELS A PARKED RANKED QUEUE. The queue outlives the matchmaking screen
      // by design (`queueKeeper` is a module singleton), so without this it keeps searching
      // under an account that is gone and takes the screen back on a match nobody can play.
      //
      // ⚠️ THE EDGE IS LOAD-BEARING — a bare `if (!signedIn)` would be wrong. `AccountSync`
      // unmounts on every trip out to a match, which is exactly the trip that parks a queue,
      // and this effect re-runs on the way back; only a real signed-in → signed-out
      // TRANSITION means the account went away.
      dropQueue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  /**
   * AND AGAIN THE MOMENT THE NETWORK COMES BACK.
   *
   * The whole premise of self-hosted play is that it works where the internet does not, so the
   * match that most needs uploading is the one played with no connection at all — and until
   * this existed the backlog moved only on a sign-in or on the END of a LATER match. A host who
   * played a scrimmage in a gym, closed the laptop, and opened it at home on wifi had to play
   * another match before last night's went anywhere.
   *
   * ⚠️ `online` is a COARSE signal: it fires when the machine gets a network interface, which
   * is not the same as being able to reach the cloud (a captive portal is the obvious case). So
   * this is an EXTRA trigger and never the only one — both flushes stop on the first failure
   * and leave the backlog intact, so a wrong guess costs one request.
   */
  useEffect(() => {
    const onOnline = (): void => {
      void flushPracticeRuns();
      void flushLanRuns();
    };
    window.addEventListener('online', onOnline);
    // a verified email is the one fix for a practice save the server refused (403
    // `email_unverified`), and that refusal left the backlog waiting
    const onVerified = (): void => void flushPracticeRuns();
    window.addEventListener(EMAIL_VERIFIED_EVENT, onVerified);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener(EMAIL_VERIFIED_EVENT, onVerified);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rich-presence heartbeat for the FULL-SCREEN surfaces (game / solo record /
  // ranked queue) that render outside AppShell's FriendsProvider — so friends see
  // "In a match" instead of the caller silently dropping to offline mid-game. The
  // shell and room screens are heartbeated by their FriendsProvider. Fire-and-forget:
  // it only records presence, never renders.
  useEffect(() => {
    if (!signedIn) return;
    const full = screen === 'game' || screen === 'record' || screen === 'matchmaking';
    if (!full) return;
    const act: Activity = screen === 'matchmaking' ? 'lobby' : 'match';
    const beat = (): void => {
      if (document.visibilityState === 'visible') void fetchFriends(act, settingsRef.current.game).catch(() => {});
    };
    beat();
    const iv = window.setInterval(beat, 30_000);
    return () => window.clearInterval(iv);
  }, [signedIn, screen]);

  /**
   * Wrap a FULL-SCREEN surface so the "you are still queued" indicator survives it.
   *
   * The bar itself is mounted inside the menu shell, which these screens replace
   * outright — so the moment you started a practice match or a record run, the one
   * thing telling you a ranked search was still live disappeared. That is precisely
   * the situation the background queue exists to create, which made it the worst
   * possible place to hide it. `overlay` renders the compact top chip instead of
   * the bottom bar (see QueueBar).
   */
  const fullScreen = (node: JSX.Element): JSX.Element => (
    <>
      <QueueBar onOpen={openParkedQueue} overlay />
      {node}
    </>
  );

  // Lobby screens bypass AppShell, so they need their own single friends store.
  // Keeping it here means the persistent room panel has the same polling,
  // challenge, and invitation semantics as the menu-shell panel.
  const roomScreen = (node: JSX.Element): JSX.Element =>
    fullScreen(
      <FriendsProvider
        signedIn={signedIn}
        activity="lobby"
        game={settings.game}
        sound={settings.audio.volume.master > 0}
        onHostRoom={hostForChallenge}
        onQueueChallenge={startChallenge}
      >
        {node}
      </FriendsProvider>,
    );

  // full-screen surfaces (outside the shell)
  if (screen === 'game') {
    return fullScreen(
      <GameView
        settings={settings}
        session={session}
        signedIn={signedIn}
        onExit={exitGame}
        onSettingsChange={update}
        editLayout={editMobileLayout}
        tutorial={tutorialRun}
        onRestartRun={sessionKind === 'record' && !sessionCoop ? restartRun : undefined}
        onWatchReplay={(r) => {
          setReplayObj(r);
          // capture the seat NOW: `session` is torn down on the way out of the game
          setReplayRobot(session?.localRobotId ?? null);
          navigate('replay');
        }}
        onPracticeRun={keepPracticeRun}
        onSignIn={() => navigate('account')}
        onQueueAgain={queueAgain}
        /* CUSTOM ROOMS ONLY. A ranked room is the matchmaker's pairing and re-opening it
           would hand a rated match a roster nobody was matched into; a record run already
           restarts into a fresh room of its own. `requestLobby` is also absent on an older
           session, so this is undefined rather than a button that does nothing. */
        onBackToLobby={
          sessionKind === 'custom' && session?.requestLobby
            ? () => session.requestLobby?.()
            : undefined
        }
      />
    );
  }
  if (screen === 'discordlobbies') {
    return (
      <DiscordLobbyList
        group={discordGroupId}
        mainCode={discordMainCode}
        game={settings.game}
        onEnter={enterDiscordRoom}
        onBack={() => navigate('home')}
      />
    );
  }
  if (screen === 'lobby') {
    const auto = pendingAutoJoin?.config.kind === 'versus' ? pendingAutoJoin : undefined;
    return roomScreen(
      <Lobby
        settings={settings}
        onSettingsChange={update}
        /* Both exits from the lobby drop the handed-over socket reference, so a later,
           ordinary visit to this screen cannot re-adopt a room the player has left. */
        onStart={(s) => {
          setResumedRoom(null);
          setPendingLanName(null);
          beginSession(s, 'custom');
        }}
        onCancel={() => {
          setResumedRoom(null);
          setPendingLanName(null);
          /**
           * BACK GOES WHERE YOU CAME FROM, and in an activity that is the lobby browser.
           *
           * A participant reaches this screen from the Discord lobby list, never from Modes
           * — the activity auto-joins. Sending them to Modes put a screen they had not used
           * between them and the only thing they wanted, which is the other lobby, and Modes
           * in the embed is mostly entries that need an account they cannot have.
           */
          navigate(inActivity && discordGroupId ? 'discordlobbies' : 'modes');
        }}
        config={auto?.config}
        signedIn={signedIn}
        displayName={handle}
        myUserId={accountUserId}
        onOpenProfile={openProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={spectateRoom}
        autoJoin={auto?.room}
        autoJoinRegion={auto?.region}
        onAutoJoinConsumed={() => setPendingAutoJoin(null)}
        discordActivity={inActivity}
        group={discordGroupId}
        resume={resumedRoom ?? undefined}
        initialName={pendingLanName ?? undefined}
      />
    );
  }
  // LAN. Bypasses AppShell the same way `screen === 'lobby'` does — the mockup this
  // screen was redesigned against has none of the shell's chrome (rail, top bar), the
  // same reason Lobby renders here instead of inside AppShell.
  // `onConnected` goes to the CUSTOM ROOM screen, because that is what a LAN match is —
  // a code-joined room, on a different server. Nothing about the room flow changes;
  // only `gameServerUrl()` now answers with the host's machine.
  // Belt and braces on the `lanOn` guard: the Play tile is hidden and `/lan` no longer
  // parses where the flag is off, so nothing should reach this — but `navigate('lan')`
  // is still a callable function, and a screen that renders a whole feature is worth
  // guarding at the point of render too.
  if (lanOn && screen === 'lan') {
    return roomScreen(
      <LanPanel
        signedIn={signedIn}
        game={settings.game}
        onBack={() => navigate('modes')}
        displayName={handle}
        myUserId={accountUserId}
        onOpenProfile={openProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={spectateRoom}
        onConnected={(code, game, name) =>
          guardStart(() => {
            /* A WEBRTC ROOM IS ALREADY OPEN BY THE TIME WE GET HERE, so the lobby must
               JOIN it rather than offer a create/join form. Without this the player lands
               on the entry screen and has to type the code a second time — and the
               transport waiting in `pending.ts` would then be adopted by whatever they
               typed, which need not be the room it is connected to. Same one-shot
               `pendingAutoJoin` an accepted invite uses; the Lobby clears it on consume. */
            if (code) setPendingAutoJoin({ room: code, config: { kind: 'versus', game: game ?? settings.game } });
            if (name) setPendingLanName(name);
            navigate('lobby');
          })
        }
      />,
    );
  }
  if (screen === 'record') {
    return fullScreen(
      <RecordRun
        settings={settings}
        mode="solo"
        onStart={(s) => beginSession(s, 'record')}
        onCancel={() => navigate('modes')}
        /* the launcher only offers this when the server refused with `active_game`, so the
           record is the match that refusal is about — go there instead of dead-ending. */
        onRejoinActive={() => {
          const ref = loadActiveGame();
          if (ref) rejoinGame(ref);
          else navigate('modes');
        }}
      />
    );
  }
  if (screen === 'duorecord') {
    const auto = pendingAutoJoin?.config.kind === 'record' ? pendingAutoJoin : undefined;
    return roomScreen(
      <Lobby
        settings={settings}
        onSettingsChange={update}
        config={auto?.config ?? { kind: 'record', record: 'duo' }}
        onStart={(s) => beginSession(s, 'record', true)}
        onCancel={() => navigate('modes')}
        signedIn={signedIn}
        displayName={handle}
        myUserId={accountUserId}
        onOpenProfile={openProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={spectateRoom}
        autoJoin={auto?.room}
        autoJoinRegion={auto?.region}
        onAutoJoinConsumed={() => setPendingAutoJoin(null)}
        discordActivity={inActivity}
        group={discordGroupId}
      />
    );
  }
  if (screen === 'matchmaking') {
    return (
      <Matchmaking
        settings={settings}
        signedIn={signedIn}
        onStart={(s) => beginSession(s, 'ranked')}
        onCancel={() => navigate('modes')}
        onSignIn={() => navigate('account')}
        onSettingsChange={update}
        challenge={pendingChallenge ?? undefined}
        onChallengeConsumed={() => setPendingChallenge(null)}
      />
    );
  }
  if (screen === 'replay' && (route.replayId || replayObj)) {
    return fullScreen(
      <ReplayView
        replayId={route.replayId ?? undefined}
        preloadReplay={replayObj ?? undefined}
        viewerRobotId={replayObj ? replayRobot : null}
        adminMatchId={isAdmin ? replayMatch : null}
        onClose={() => (replayObj ? navigate('home') : navigate('records'))}
      />
    );
  }

  // shell screens. Signed-in builds fold the region menu INTO the profile
  // avatar's popover (one control, not two) — switching server is still one
  // click away, just behind the avatar instead of permanently taking up bar
  // width. Without auth there's no avatar to hang it on, so it stays a bar-level
  // control on its own. No bar "Profile" button beside it: the home keycaps and the
  // rail both already go there, and a third copy was the bar repeating nav (review 01-06).
  const right = authEnabled ? (
    <ProfileMenu
      handle={handle}
      preferredServerId={settings.preferredServerId ?? selectedServerId()}
      onChangeServer={(id) => update({ ...settings, preferredServerId: id })}
      onAccount={() => navigate('account')}
      onAppearance={() => navigate('account', { sub: 'appearance' })}
    />
  ) : (
    <ServerMenu
      value={settings.preferredServerId ?? selectedServerId()}
      onChange={(id) => update({ ...settings, preferredServerId: id })}
    />
  );

  const configureSection: ConfigureSection = isConfigureSection(route.sub) ? route.sub : 'robot';
  const recordsTab: RecordsTab = isRecordsTab(route.sub) ? route.sub : 'leaderboard';
  /** the two public legal screens — the blocking gates below suspend on them */
  const legalScreen = screen === 'privacy' || screen === 'terms';

  return (
    <FriendsProvider
      signedIn={signedIn}
      activity="menu"
      game={settings.game}
      sound={settings.audio.volume.master > 0}
      onHostRoom={hostForChallenge}
      onQueueChallenge={startChallenge}
    >
      {/* the standing "still queued" bar — only appears when a search is PARKED,
          i.e. the player queued and then went somewhere else */}
      <QueueBar onOpen={openParkedQueue} />
      <AppShell
        active={navFor(screen)}
        onNav={goNav}
        right={right}
        showAdmin={isAdmin}
        showRail={screen !== 'home'}
        onDownload={() => navigate('download')}
        onContributors={() => navigate('contributors')}
        onChangelog={() => navigate('changelogs')}
        onPrivacy={() => navigate('privacy')}
        onTerms={() => navigate('terms')}
        onDonate={() => navigate('donate')}
        signedIn={signedIn}
        onOpenProfile={openProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={spectateRoom}
        myUserId={accountUserId}
        game={settings.game}
      >
      {authEnabled && <AccountSync onUser={onSyncUser} onLoad={onSyncLoad} seed={onSyncSeed} />}
      {/* THE BLOCKING GATES, NESTED RATHER THAN STACKED. A brand-new account trips both
          (an OAuth sign-up has no username AND no acceptance), and two
          `.ds-modal-backdrop`s at once double-darken the page and show one dialog dimmed
          behind the other. `TermsGate` renders its children only once it is satisfied, so
          the order is structural: agree to the service, then pick a name inside it. */}
      {/* ⚠️ BOTH GATES STAND DOWN ON THE LEGAL PAGES. They are full-viewport backdrops
          rendered BESIDE the routed screen, so on `/terms` and `/privacy` they covered
          the documents themselves — including the new tab the gate's own links open.
          Those two screens are public by design (see the render site below), so a
          signed-in account that has not accepted yet can still go and read them; the
          gate is back the moment the route is anything else. */}
      {authEnabled && (
        <TermsGate suspended={legalScreen}>
          <UsernameGate suspended={legalScreen}>
            {/* THE CLAIM DIALOG waits behind both gates (it is their child), and behind every
                other modal this shell can raise — an announcement, a start guard. It is
                inside `AppShell`, which a match, a lobby and the ranked screen replace, so it
                can never appear over a field. "Equip now" on a decal puts it on the active
                robot, the same edit the builder's own swatch makes. */}
            <RewardDialog
              blocked={legalScreen || annActive || showChainDisclaimer || blockedByActive || rejoinGone || badStart || startBlocked || !!pendingStart}
              onEquipCosmetic={equipCosmetic}
            />
          </UsernameGate>
        </TermsGate>
      )}

      {screen === 'home' && (
        <HomeMenu
          settings={settings}
          multiplayer={multiplayer}
          discord={inActivity ? { people: discordPeople, onJoin: joinDiscordLobby } : null}
          onNav={goNav}
          onGame={(g) => {
            update(switchGame(settings, g));
            if (isWebHistory) {
              const path = pathFor(screen, route, g);
              if (window.location.pathname !== path) window.history.pushState(null, '', path);
            }
          }}
        />
      )}

      {screen === 'modes' && (
        <ModeSelect
          game={settings.game}
          multiplayer={multiplayer}
          signedIn={signedIn}
          activeGame={activeGame ? { kind: activeGame.kind } : null}
          onRejoin={() => {
            const ref = loadActiveGame();
            if (ref) rejoinGame(ref);
            else setActiveGame(null);
          }}
          onFreeDrive={() =>
            guardStart(() => {
              update({ ...settings, mode: 'free' });
              navigate('game');
            })
          }
          onSoloMatch={() =>
            guardStart(() => {
              update({ ...settings, mode: 'match' });
              navigate('game');
            })
          }
          onRecordRun={() => guardStart(() => navigate('record'))}
          onDuoRecord={() => guardStart(() => navigate('duorecord'))}
          onRanked={() => guardStart(() => navigate('matchmaking'))}
          onCustomRoom={() => guardStart(() => navigate('lobby'))}
          onWatch={() => navigate('watch')}
          onLan={() => navigate('lan')}
          compete={!inActivity}
          /* THE FIRST-RUN OFFER. Absent once the device flag is set, and absent for a game with
             no tutorial — `ModeSelect` renders nothing for it either way, so the page loses a
             section rather than gaining a disabled tile. */
          onTutorial={moduleFor(settings.game).tutorial ? startTutorial : undefined}
        />
      )}
      {/* one-time "this sim isn't realistic" disclaimer for Chain Reaction */}
      {showChainDisclaimer && (
        <OverlayDialog title="Chain Reaction in DSIM" onClose={dismissChainDisclaimer}>
          <p className="ds-sub overlay-sub">
            Chain Reaction is the <b>Unofficial FTC Discord’s CAD Competition</b> game.
            DSIM’s version is a rough, for-fun approximation: <b>robots here don’t drive,
            shoot or score like the real ones will</b>, so don’t base CAD decisions on it.
          </p>
          {/* SENTENCE CASE, and `.ds-dialog-actions` to drop the all-caps
              tracking with it. These five are SHELL dialogs — the same surface
              as Announcements' "Got it" and every `.ds-btn` around them — not
              the match overlays in GameView, whose caps match the HUD they sit
              on. Shipping `GOT IT` here beside `Got it` there was one word in
              two casings in one shell. */}
          <div className="overlay-buttons ds-dialog-actions">
            <button onClick={dismissChainDisclaimer}>Got it</button>
          </div>
        </OverlayDialog>
      )}
      {/* the start guards live here, not on `modes`, because a start can also be
          triggered from a lobby/queue screen that this shell doesn't render.
          NO `onClose`: both answers do something, and Escape must not pick one — least of
          all the forfeit. The body names the game and what leaving it costs (design review
          19-06): a ranked seat left mid-match is still rated, as a loss (`room.ts` `departed`). */}
      {blockedByActive && (
        <OverlayDialog title="You’re already in a game">
          <p className="ds-sub overlay-sub">
            {blockedKind === 'ranked'
              ? 'Your ranked match is still running. Leaving it counts as a loss.'
              : blockedKind === 'record'
                ? 'Your record run is still running. Leaving it ends the run.'
                : 'Your custom room match is still running.'}
          </p>
          {/* PRIMARY RIGHTMOST (ui-standard §6), in every dialog below, and `autoFocus` on it:
              `useDialog` otherwise focuses the FIRST control, which is now the forfeit */}
          <div className="overlay-buttons ds-dialog-actions">
            <button className="secondary" onClick={abandonActiveGame}>
              {blockedKind === 'ranked' ? 'Forfeit match' : blockedKind === 'record' ? 'Leave run' : 'Leave match'}
            </button>
            <button
              autoFocus
              onClick={() => {
                const ref = loadActiveGame();
                setBlockedByActive(false);
                if (ref) rejoinGame(ref);
                else setActiveGame(null);
              }}
            >
              Rejoin match
            </button>
          </div>
        </OverlayDialog>
      )}
      {/* the saved seat could not be reclaimed — see the refusal watcher in `rejoinGame`.
          One sentence on the menu, instead of the "connection lost" panel on a game screen
          for a match that no longer exists. */}
      {rejoinGone && (
        <OverlayDialog title="That match is over" onClose={() => setRejoinGone(false)}>
          <p className="ds-sub overlay-sub">
            It finished, or it was held open too long for you to get back into.
          </p>
          <div className="overlay-buttons ds-dialog-actions">
            <button onClick={() => setRejoinGone(false)}>Back to menu</button>
          </div>
        </OverlayDialog>
      )}
      {badStart && (
        <OverlayDialog title="Start position doesn’t fit this robot" onClose={() => setBadStart(false)}>
          <p className="ds-sub overlay-sub">
            Your saved start position isn’t legal for this build. Move it, or pick a preset
            position.
          </p>
          <div className="overlay-buttons ds-dialog-actions">
            <button className="secondary" onClick={() => setBadStart(false)}>
              Cancel
            </button>
            <button
              autoFocus
              onClick={() => {
                setBadStart(false);
                navigate('configure', { sub: 'match' });
              }}
            >
              Fix start position
            </button>
          </div>
        </OverlayDialog>
      )}
      {startBlocked && (
        <OverlayDialog
          title={lockedOut ? 'Down for maintenance' : 'Server restarting soon'}
          onClose={() => setStartBlocked(false)}
        >
          <p className="ds-sub overlay-sub">
            {lockedOut
              ? maintenanceLine(maintenance) ??
                'DSIM is down for maintenance. New games are paused.'
              : 'Server is restarting shortly. New games are paused for a moment.'}
          </p>
          <div className="overlay-buttons ds-dialog-actions">
            <button onClick={() => setStartBlocked(false)}>Back to menu</button>
          </div>
        </OverlayDialog>
      )}
      {pendingStart && (
        <OverlayDialog title="Update required" onClose={() => setPendingStart(null)}>
          <p className="ds-sub overlay-sub">
            A newer version has shipped. Refresh to update before starting.
          </p>
          <div className="overlay-buttons ds-dialog-actions">
            <button className="secondary" onClick={() => setPendingStart(null)}>
              Not now
            </button>
            <button autoFocus onClick={() => window.location.reload()}>
              Refresh and update
            </button>
          </div>
        </OverlayDialog>
      )}

      {screen === 'configure' && (
        <Configure
          settings={settings}
          onChange={update}
          section={configureSection}
          onSection={(s) => navigate('configure', { sub: s })}
          onEditTouchControls={editTouchControls}
          onTutorial={moduleFor(settings.game).tutorial ? startTutorial : undefined}
        />
      )}

      {screen === 'records' && (
        <Records
          tab={recordsTab}
          onTab={(t) => navigate('records', { sub: t })}
          myUserId={accountUserId}
          game={settings.game}
          onWatch={watchReplay}
          onWatchLocal={(r) => {
            // a local practice log has no server id — hand the container straight to the
            // viewer, the same path the just-played run takes off the results screen
            setReplayObj(r);
            setReplayRobot(r.setups[0]?.id ?? null);
            navigate('replay');
          }}
          onOpenProfile={openProfile}
        />
      )}

      {screen === 'profile' && route.username && (
        <Profile
          key={route.username}
          username={route.username}
          signedIn={signedIn}
          viewerUsername={viewerUsername}
          nav={{ onWatch: watchReplay, onOpenProfile: openProfile }}
        />
      )}
      {screen === 'watch' && <WatchLive onWatch={spectateRoom} onBack={() => navigate('modes')} />}
      {screen === 'download' && <Download />}
      {screen === 'contributors' && <Contributors onOpenProfile={openProfile} />}
      {/* legal pages are public and must stay reachable without an account —
          AdSense review fetches /privacy directly */}
      {screen === 'privacy' && <Privacy />}
      {screen === 'terms' && <Terms />}
      {screen === 'donate' && <Donate signedIn={signedIn} />}
      {screen === 'changelogs' && <Changelog />}
      {screen === 'account' && route.sub === 'appearance' && (
        <Appearance
          onTab={profileTab}
          onHandleSaved={setHandle}
          onViewProfile={openProfile}
          onRobotBuilder={() => navigate('configure', { sub: 'robot' })}
        />
      )}
      {screen === 'account' && route.sub !== 'appearance' && (
        <Account settings={settings} onChange={update} onDonate={() => navigate('donate')} onTab={profileTab} />
      )}
      {screen === 'accountreset' && <AccountReset onAccount={() => navigate('account')} />}
      {screen === 'accountverify' && <AccountVerify onAccount={() => navigate('account')} />}
      {screen === 'admin' && isAdmin && (
        <LoadBoundary what="the console" fallback={<p className="ds-loading">Loading the console…</p>}>
          <Admin onWatch={spectateRoom} onWatchReplay={watchReplay} />
        </LoadBoundary>
      )}
      {screen === 'dev' &&
        (() => {
          const Dev = devRouteFor(settings.game, route.dev ?? '');
          return Dev ? <Dev /> : null;
        })()}

      {/* Patch notes / new-season + new-act reveals — shown once on the menu shell,
          never over a live match (the game screen returns before this). Mounted
          LAST on purpose: it renders an overlay, so its position in the tree is
          cosmetically irrelevant but semantically load-bearing — first-in-DOM is
          what a crawler reads as the page's main content, and patch notes were
          winning that slot over the homepage itself. (Fresh visitors never see
          it at all now — see `useAnnouncements`.) It stands down on the legal pages like the
          gates above: a full-screen reveal over /privacy covered the document itself. */}
      {!legalScreen && (
        <Announcements muted={settings.audio.volume.master <= 0} onActiveChange={setAnnActive} />
      )}
      </AppShell>
    </FriendsProvider>
  );
}
