import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { loadSettings, saveSettings } from '../settings';
import { saveAccountSettings, fetchAdminStatus } from '../net/api';
import { useNewVersion } from '../net/version';
import { Admin } from './Admin';
import { AccountSync } from './AccountSync';
import { Menu } from './Menu';
import { GameView } from './GameView';
import { Lobby } from './Lobby';
import { AppShell, type ShellNav } from './AppShell';
import { Home } from './Home';
import { Leaderboard } from './Leaderboard';
import { RecordRun } from './RecordRun';
import { Matchmaking } from './Matchmaking';
import { ReplayView } from './ReplayView';
import { AccountButton } from './AccountButton';
import { Download } from './Download';
import { Stats } from './Stats';
import { Account } from './Account';
import { authEnabled } from '../lib/authClient';
import { gameServerConfigured } from '../net/env';
import type { NetSession } from '../net/session';
import type { Replay } from '../sim/replay';

type Screen =
  | 'home'
  | 'robot'
  | 'leaderboard'
  | 'lobby'
  | 'record'
  | 'matchmaking'
  | 'replay'
  | 'game'
  | 'download'
  | 'stats'
  | 'account'
  | 'admin';

/**
 * Tiny path router (no dependency). Each screen is a real URL — /leaderboard,
 * /my-robot, /replay/<id>, … — via the History API, so links are shareable and
 * back/forward work. The web build uses an absolute base + a vercel.json SPA
 * rewrite so a deep load/refresh resolves. Under Electron (file://) there is no
 * History to push, so we route by state only (isWebHistory === false).
 */
const isWebHistory = typeof window !== 'undefined' && window.location.protocol !== 'file:';

function pathFor(screen: Screen, replayId: string | null): string {
  switch (screen) {
    case 'home':
      return '/';
    case 'robot':
      return '/my-robot';
    case 'leaderboard':
      return '/leaderboard';
    case 'lobby':
      return '/lobby';
    case 'record':
      return '/record';
    case 'matchmaking':
      return '/ranked';
    case 'replay':
      return replayId ? `/replay/${encodeURIComponent(replayId)}` : '/replay';
    case 'game':
      return '/play';
    case 'download':
      return '/download';
    case 'stats':
      return '/stats';
    case 'account':
      return '/account';
    case 'admin':
      return '/admin';
  }
}

function parsePath(pathname: string): { screen: Screen; replayId: string | null } {
  const replay = pathname.match(/^\/replay\/(.+)$/);
  if (replay) return { screen: 'replay', replayId: decodeURIComponent(replay[1]) };
  if (pathname.startsWith('/leaderboard')) return { screen: 'leaderboard', replayId: null };
  if (pathname.startsWith('/my-robot')) return { screen: 'robot', replayId: null };
  if (pathname.startsWith('/lobby')) return { screen: 'lobby', replayId: null };
  if (pathname.startsWith('/record')) return { screen: 'record', replayId: null };
  if (pathname.startsWith('/ranked')) return { screen: 'matchmaking', replayId: null };
  if (pathname.startsWith('/download')) return { screen: 'download', replayId: null };
  if (pathname.startsWith('/stats')) return { screen: 'stats', replayId: null };
  if (pathname.startsWith('/account')) return { screen: 'account', replayId: null };
  if (pathname.startsWith('/admin')) return { screen: 'admin', replayId: null };
  // /play (a live game) can't be restored without a session ⇒ home
  return { screen: 'home', replayId: null };
}

export function App() {
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const start = isWebHistory
    ? parsePath(window.location.pathname)
    : { screen: 'home' as Screen, replayId: null };
  const [screen, setScreen] = useState<Screen>(start.screen);
  const [replayId, setReplayId] = useState<string | null>(start.replayId);
  const [session, setSession] = useState<NetSession | null>(null);
  // a just-played replay to watch in-memory (not yet persisted, so no URL id)
  const [replayObj, setReplayObj] = useState<Replay | null>(null);

  // reflect back/forward into state (no push — the URL already changed)
  useEffect(() => {
    if (!isWebHistory) return;
    const onPop = (): void => {
      const s = parsePath(window.location.pathname);
      setScreen(s.screen);
      setReplayId(s.replayId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** the single way screens change — updates state AND the URL */
  const navigate = (next: Screen, rid: string | null = null): void => {
    setScreen(next);
    setReplayId(rid);
    if (next !== 'replay') setReplayObj(null); // leaving the viewer drops the in-memory replay
    if (isWebHistory) {
      const path = pathFor(next, rid);
      if (window.location.pathname !== path) window.history.pushState(null, '', path);
    }
  };

  // when signed in, mirror settings to the account (debounced) as well as local
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
  // is this account an admin? (server-authorized against ADMIN_USER_IDS) — gates the
  // Admin tab; the server independently enforces every admin action
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
  const guardStart = (go: () => void): void => {
    if (newVersion) setPendingStart(() => go);
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
        onCancel={() => navigate('home')}
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
        onCancel={() => navigate('home')}
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
        onCancel={() => navigate('home')}
        onSignIn={() => navigate('account')}
      />
    );
  }
  if (screen === 'replay' && (replayId || replayObj)) {
    return (
      <ReplayView
        replayId={replayId ?? undefined}
        preloadReplay={replayObj ?? undefined}
        onClose={() => navigate(replayObj ? 'home' : 'leaderboard')}
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
  const active: ShellNav =
    screen === 'leaderboard'
      ? 'leaderboard'
      : screen === 'stats'
        ? 'stats'
        : screen === 'download'
          ? 'download'
          : screen === 'robot'
            ? 'robot'
            : screen === 'admin'
              ? 'admin'
              : 'home';
  return (
    <AppShell active={active} onNav={(n) => navigate(n)} right={right} showAdmin={isAdmin}>
      {authEnabled && <AccountSync onUser={onSyncUser} onLoad={onSyncLoad} seed={onSyncSeed} />}
      {screen === 'home' && (
        <Home
          settings={settings}
          onChange={update}
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
          onRanked={() => guardStart(() => navigate('matchmaking'))}
          onCustomRoom={() => guardStart(() => navigate('lobby'))}
          onEditRobot={() => navigate('robot')}
        />
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
      {screen === 'robot' && <Menu settings={settings} onChange={update} />}
      {screen === 'leaderboard' && <Leaderboard onWatch={(id) => navigate('replay', id)} />}
      {screen === 'stats' && <Stats />}
      {screen === 'download' && <Download />}
      {screen === 'account' && <Account settings={settings} onChange={update} />}
      {screen === 'admin' && isAdmin && <Admin />}
    </AppShell>
  );
}
