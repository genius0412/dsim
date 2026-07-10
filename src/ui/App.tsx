import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { loadSettings, saveSettings } from '../settings';
import { saveAccountSettings, fetchAdminStatus } from '../net/api';
import { useNewVersion } from '../net/version';
import { useServerNotice } from '../net/notice';
import { Admin } from './Admin';
import { AccountSync } from './AccountSync';
import { GameView } from './GameView';
import { Lobby } from './Lobby';
import { AppShell, type ShellNav } from './AppShell';
import { HomeMenu } from './HomeMenu';
import { ModeSelect } from './ModeSelect';
import { Configure, isConfigureSection, type ConfigureSection } from './Configure';
import { Records, isRecordsTab, type RecordsTab } from './Records';
import { RecordRun } from './RecordRun';
import { Matchmaking } from './Matchmaking';
import { ReplayView } from './ReplayView';
import { AccountButton } from './AccountButton';
import { Download } from './Download';
import { Profile } from './Profile';
import { UsernameGate } from './UsernameGate';
import { Account } from './Account';
import { authEnabled } from '../lib/authClient';
import { gameServerConfigured, setSelectedServer } from '../net/env';
import type { NetSession } from '../net/session';
import type { Replay } from '../sim/replay';

type Screen =
  | 'home'
  | 'modes'
  | 'configure'
  | 'records'
  | 'lobby'
  | 'record'
  | 'duorecord'
  | 'matchmaking'
  | 'replay'
  | 'game'
  | 'download'
  | 'profile'
  | 'account'
  | 'admin';

/** everything a route needs beyond the screen itself */
interface RouteArgs {
  /** `/replay/<id>` */
  replayId: string | null;
  /** `/profile/<username>` */
  username: string | null;
  /** the section/tab of a screen that has them: `/configure/<sub>`, `/records/<sub>` */
  sub: string | null;
}
const NO_ARGS: RouteArgs = { replayId: null, username: null, sub: null };

/**
 * Tiny path router (no dependency). Each screen is a real URL — /modes,
 * /configure/robot, /records/career, /replay/<id>, … — via the History API, so
 * links are shareable and back/forward work. The web build uses an absolute base
 * + a vercel.json SPA rewrite so a deep load/refresh resolves. Under Electron
 * (file://) there is no History to push, so we route by state only
 * (isWebHistory === false).
 */
const isWebHistory = typeof window !== 'undefined' && window.location.protocol !== 'file:';

function pathFor(screen: Screen, a: RouteArgs): string {
  switch (screen) {
    case 'home':
      return '/';
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
    case 'record':
      return '/record';
    case 'duorecord':
      return '/duo-record';
    case 'matchmaking':
      return '/ranked';
    case 'replay':
      return a.replayId ? `/replay/${encodeURIComponent(a.replayId)}` : '/replay';
    case 'game':
      return '/play';
    case 'download':
      return '/download';
    case 'account':
      return '/account';
    case 'admin':
      return '/admin';
  }
}

function parsePath(pathname: string): { screen: Screen } & RouteArgs {
  const at = (screen: Screen, extra: Partial<RouteArgs> = {}) => ({
    screen,
    ...NO_ARGS,
    ...extra,
  });

  const replay = pathname.match(/^\/replay\/(.+)$/);
  if (replay) return at('replay', { replayId: decodeURIComponent(replay[1]) });
  const profile = pathname.match(/^\/profile\/(.+)$/);
  if (profile) return at('profile', { username: decodeURIComponent(profile[1]) });

  const configure = pathname.match(/^\/configure(?:\/([^/]+))?/);
  if (configure) return at('configure', { sub: configure[1] ?? 'robot' });
  const records = pathname.match(/^\/records(?:\/([^/]+))?/);
  if (records) return at('records', { sub: records[1] ?? 'leaderboard' });

  // legacy paths kept alive so old links (and anything a player bookmarked
  // before the nav restructure) still resolve to their new home
  if (pathname.startsWith('/my-robot')) return at('configure', { sub: 'robot' });
  if (pathname.startsWith('/leaderboard')) return at('records', { sub: 'leaderboard' });
  if (pathname.startsWith('/stats')) return at('records', { sub: 'career' });

  if (pathname.startsWith('/modes')) return at('modes');
  if (pathname.startsWith('/lobby')) return at('lobby');
  if (pathname.startsWith('/duo-record')) return at('duorecord');
  if (pathname.startsWith('/record')) return at('record');
  if (pathname.startsWith('/ranked')) return at('matchmaking');
  if (pathname.startsWith('/download')) return at('download');
  if (pathname.startsWith('/account')) return at('account');
  if (pathname.startsWith('/admin')) return at('admin');
  // /play (a live game) can't be restored without a session ⇒ home
  return at('home');
}

/** which rail/menu entry lights up for a given screen */
function navFor(screen: Screen): ShellNav {
  switch (screen) {
    case 'modes':
    case 'game':
    case 'lobby':
    case 'record':
    case 'duorecord':
    case 'matchmaking':
      return 'play';
    case 'configure':
      return 'configure';
    case 'records':
      return 'records';
    case 'account':
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

export function App() {
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const start = isWebHistory
    ? parsePath(window.location.pathname)
    : { screen: 'home' as Screen, ...NO_ARGS };
  const [screen, setScreen] = useState<Screen>(start.screen);
  const [route, setRoute] = useState<RouteArgs>(start);
  const [session, setSession] = useState<NetSession | null>(null);
  // a just-played replay to watch in-memory (not yet persisted, so no URL id)
  const [replayObj, setReplayObj] = useState<Replay | null>(null);

  // reflect back/forward into state (no push — the URL already changed)
  useEffect(() => {
    if (!isWebHistory) return;
    const onPop = (): void => {
      const s = parsePath(window.location.pathname);
      setScreen(s.screen);
      setRoute(s);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** the single way screens change — updates state AND the URL */
  const navigate = (next: Screen, args: Partial<RouteArgs> = {}): void => {
    const a: RouteArgs = { ...NO_ARGS, ...args };
    setScreen(next);
    setRoute(a);
    if (next !== 'replay') setReplayObj(null); // leaving the viewer drops the in-memory replay
    if (isWebHistory) {
      const path = pathFor(next, a);
      if (window.location.pathname !== path) window.history.pushState(null, '', path);
    }
  };

  /** open a player's public profile page (/profile/<username>) */
  const openProfile = (username: string): void => navigate('profile', { username });
  const watchReplay = (replayId: string): void => navigate('replay', { replayId });

  // when signed in, mirror settings to the account (debounced) as well as local
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // restore the player's preferred server region (from local settings, or synced
  // from the account once AccountSync applies it) so every connect uses it
  useEffect(() => {
    if (settings.preferredServerId) setSelectedServer(settings.preferredServerId);
  }, [settings.preferredServerId]);

  const update = (s: GameSettings): void => {
    setSettings(s);
    saveSettings(s);
    if (accountUserId) {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveAccountSettings(s), 700);
    }
  };

  const onSyncUser = useCallback((id: string | null) => setAccountUserId(id), []);
  const onSyncLoad = useCallback((s: GameSettings) => {
    setSettings(s);
    saveSettings(s);
  }, []);
  const onSyncSeed = useCallback(() => void saveAccountSettings(settingsRef.current), []);

  const exitGame = (): void => {
    session?.dispose();
    setSession(null);
    navigate('home');
  };

  // a newer client build shipped while this tab stayed open: prompt to refresh when
  // the player STARTS a run (never mid-run), so they aren't stuck on a stale version
  const newVersion = useNewVersion();
  const [pendingStart, setPendingStart] = useState<(() => void) | null>(null);
  // a scheduled server restart is live (admin notice): don't let anyone START a new
  // game / queue — they'd just get dropped by the restart. People already in a game
  // are untouched (this only guards the start actions). Info notices don't block.
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [startBlocked, setStartBlocked] = useState(false);
  const guardStart = (go: () => void): void => {
    if (restartPending) setStartBlocked(true);
    else if (newVersion) setPendingStart(() => go);
    else go();
  };

  const multiplayer = gameServerConfigured();
  // ranked needs a real account (ELO/leaderboard). accountUserId is set by
  // AccountSync on sign-in and stays null when auth is off, so signed-out and
  // no-auth builds both lock ranked — custom rooms stay open to everyone.
  const signedIn = accountUserId !== null;

  // full-screen surfaces (outside the shell)
  if (screen === 'game') {
    return (
      <GameView
        settings={settings}
        session={session}
        signedIn={signedIn}
        onExit={exitGame}
        onWatchReplay={(r) => {
          setReplayObj(r);
          navigate('replay');
        }}
      />
    );
  }
  if (screen === 'lobby') {
    return (
      <Lobby
        settings={settings}
        onStart={(s) => {
          setSession(s);
          navigate('game');
        }}
        onCancel={() => navigate('modes')}
      />
    );
  }
  if (screen === 'record') {
    return (
      <RecordRun
        settings={settings}
        mode="solo"
        onStart={(s) => {
          setSession(s);
          navigate('game');
        }}
        onCancel={() => navigate('modes')}
        onPreferServer={(id) => update({ ...settings, preferredServerId: id })}
      />
    );
  }
  if (screen === 'duorecord') {
    return (
      <Lobby
        settings={settings}
        config={{ kind: 'record', record: 'duo' }}
        onStart={(s) => {
          setSession(s);
          navigate('game');
        }}
        onCancel={() => navigate('modes')}
      />
    );
  }
  if (screen === 'matchmaking') {
    return (
      <Matchmaking
        settings={settings}
        signedIn={signedIn}
        onStart={(s) => {
          setSession(s);
          navigate('game');
        }}
        onCancel={() => navigate('modes')}
        onSignIn={() => navigate('account')}
        onSettingsChange={update}
      />
    );
  }
  if (screen === 'replay' && (route.replayId || replayObj)) {
    return (
      <ReplayView
        replayId={route.replayId ?? undefined}
        preloadReplay={replayObj ?? undefined}
        onClose={() => (replayObj ? navigate('home') : navigate('records'))}
      />
    );
  }

  // shell screens
  const right = authEnabled ? (
    <AccountButton onAccount={() => navigate('account')} />
  ) : (
    <button className="ds-btn ghost" onClick={() => navigate('account')}>
      Settings
    </button>
  );

  const configureSection: ConfigureSection = isConfigureSection(route.sub) ? route.sub : 'robot';
  const recordsTab: RecordsTab = isRecordsTab(route.sub) ? route.sub : 'leaderboard';

  return (
    <AppShell
      active={navFor(screen)}
      onNav={(n) => navigate(screenForNav(n))}
      right={right}
      showAdmin={isAdmin}
      showRail={screen !== 'home'}
      onDownload={() => navigate('download')}
    >
      {authEnabled && <AccountSync onUser={onSyncUser} onLoad={onSyncLoad} seed={onSyncSeed} />}
      {authEnabled && <UsernameGate />}

      {screen === 'home' && (
        <HomeMenu
          settings={settings}
          multiplayer={multiplayer}
          onNav={(n) => navigate(screenForNav(n))}
        />
      )}

      {screen === 'modes' && (
        <ModeSelect
          multiplayer={multiplayer}
          signedIn={signedIn}
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
        />
      )}

      {/* the start guards live here, not on `modes`, because a start can also be
          triggered from a lobby/queue screen that this shell doesn't render */}
      {startBlocked && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Server restarting soon</h2>
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              A scheduled server update is about to happen, so new games are paused for a moment —
              you’d only get dropped by the restart. Hang tight; it’ll be back in a minute.
            </p>
            <div className="overlay-buttons">
              <button onClick={() => setStartBlocked(false)}>OK</button>
            </div>
          </div>
        </div>
      )}
      {pendingStart && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Update required</h2>
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              A newer version of the sim has shipped. Everyone has to be on the same version to
              play — especially for multiplayer — so refresh to update before starting a run.
            </p>
            <div className="overlay-buttons">
              <button onClick={() => window.location.reload()}>REFRESH &amp; UPDATE</button>
              <button className="ghost" onClick={() => setPendingStart(null)}>
                NOT NOW
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === 'configure' && (
        <Configure
          settings={settings}
          onChange={update}
          section={configureSection}
          onSection={(s) => navigate('configure', { sub: s })}
        />
      )}

      {screen === 'records' && (
        <Records
          tab={recordsTab}
          onTab={(t) => navigate('records', { sub: t })}
          myUserId={accountUserId}
          onWatch={watchReplay}
          onOpenProfile={openProfile}
        />
      )}

      {screen === 'profile' && route.username && (
        <Profile
          username={route.username}
          nav={{ onWatch: watchReplay, onOpenProfile: openProfile }}
        />
      )}
      {screen === 'download' && <Download />}
      {screen === 'account' && <Account settings={settings} onChange={update} />}
      {screen === 'admin' && isAdmin && <Admin />}
    </AppShell>
  );
}
