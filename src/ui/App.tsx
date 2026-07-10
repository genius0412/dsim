import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { loadSettings, saveSettings } from '../settings';
import { saveAccountSettings, fetchAdminStatus } from '../net/api';
import { useNewVersion } from '../net/version';
import { useServerNotice } from '../net/notice';
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
import { Profile } from './Profile';
import { UsernameGate } from './UsernameGate';
import { Account } from './Account';
import { authEnabled } from '../lib/authClient';
import { gameServerConfigured, setSelectedServer, gameServerUrlWith } from '../net/env';
import type { NetSession } from '../net/session';
import { ServerSession } from '../net/serverSession';
import { WebSocketTransport } from '../net/transport';
import { encodeMsg } from '../net/protocol';
import { loadActiveGame, saveActiveGame, clearActiveGame, type ActiveGameRef } from '../net/activeGame';
import type { Replay } from '../sim/replay';

type Screen =
  | 'home'
  | 'robot'
  | 'leaderboard'
  | 'lobby'
  | 'record'
  | 'duorecord'
  | 'matchmaking'
  | 'replay'
  | 'game'
  | 'download'
  | 'stats'
  | 'profile'
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

function pathFor(screen: Screen, replayId: string | null, username: string | null): string {
  switch (screen) {
    case 'profile':
      return username ? `/profile/${encodeURIComponent(username)}` : '/leaderboard';
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
    case 'duorecord':
      return '/duo-record';
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

function parsePath(pathname: string): {
  screen: Screen;
  replayId: string | null;
  username: string | null;
} {
  const replay = pathname.match(/^\/replay\/(.+)$/);
  if (replay) return { screen: 'replay', replayId: decodeURIComponent(replay[1]), username: null };
  const profile = pathname.match(/^\/profile\/(.+)$/);
  if (profile)
    return { screen: 'profile', replayId: null, username: decodeURIComponent(profile[1]) };
  if (pathname.startsWith('/leaderboard')) return { screen: 'leaderboard', replayId: null, username: null };
  if (pathname.startsWith('/my-robot')) return { screen: 'robot', replayId: null, username: null };
  if (pathname.startsWith('/lobby')) return { screen: 'lobby', replayId: null, username: null };
  if (pathname.startsWith('/duo-record')) return { screen: 'duorecord', replayId: null, username: null };
  if (pathname.startsWith('/record')) return { screen: 'record', replayId: null, username: null };
  if (pathname.startsWith('/ranked')) return { screen: 'matchmaking', replayId: null, username: null };
  if (pathname.startsWith('/download')) return { screen: 'download', replayId: null, username: null };
  if (pathname.startsWith('/stats')) return { screen: 'stats', replayId: null, username: null };
  if (pathname.startsWith('/account')) return { screen: 'account', replayId: null, username: null };
  if (pathname.startsWith('/admin')) return { screen: 'admin', replayId: null, username: null };
  // /play (a live game) can't be restored without a session ⇒ home
  return { screen: 'home', replayId: null, username: null };
}

export function App() {
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const start = isWebHistory
    ? parsePath(window.location.pathname)
    : { screen: 'home' as Screen, replayId: null, username: null };
  const [screen, setScreen] = useState<Screen>(start.screen);
  const [replayId, setReplayId] = useState<string | null>(start.replayId);
  const [profileUser, setProfileUser] = useState<string | null>(start.username);
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
      setProfileUser(s.username);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** the single way screens change — updates state AND the URL */
  const navigate = (next: Screen, rid: string | null = null, uname: string | null = null): void => {
    setScreen(next);
    setReplayId(rid);
    setProfileUser(uname);
    if (next !== 'replay') setReplayObj(null); // leaving the viewer drops the in-memory replay
    if (isWebHistory) {
      const path = pathFor(next, rid, uname);
      if (window.location.pathname !== path) window.history.pushState(null, '', path);
    }
  };

  /** open a player's public profile page (/profile/<username>) */
  const openProfile = (username: string): void => navigate('profile', null, username);

  // when signed in, mirror settings to the account (debounced) as well as local
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
  // is this account an admin? (server-authorized against ADMIN_USER_IDS) — gates the
  // Admin tab; the server independently enforces every admin action
  const [isAdmin, setIsAdmin] = useState(false);
  // has the admin-status check settled? (so we don't bounce a real admin off an
  // admin-only deep-link before the async check resolves)
  const [adminChecked, setAdminChecked] = useState(false);
  useEffect(() => {
    if (!accountUserId) {
      setIsAdmin(false);
      setAdminChecked(true);
      return;
    }
    let cancelled = false;
    setAdminChecked(false);
    fetchAdminStatus().then((s) => {
      if (!cancelled) {
        setIsAdmin(s.isAdmin);
        setAdminChecked(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountUserId]);
  // the Download page is admin-only for now — bounce a non-admin who deep-links or
  // refreshes on /download back home (once the admin check has actually settled)
  useEffect(() => {
    if (screen === 'download' && adminChecked && !isAdmin) navigate('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, adminChecked, isAdmin]);

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

  // the multiplayer game this browser is currently in (persisted to localStorage), so
  // the player can REJOIN it after navigating away and is stopped from starting a 2nd.
  const [activeGame, setActiveGame] = useState<ActiveGameRef | null>(() => loadActiveGame());

  /** enter a networked game: remember it (for rejoin + the single-game guard), then
   * show the game screen. Solo play never calls this (it has no session). */
  const beginSession = (s: NetSession, kind: ActiveGameRef['kind']): void => {
    if (s.room && s.clientId) {
      const ref: ActiveGameRef = {
        room: s.room,
        region: s.region,
        clientId: s.clientId,
        start: {
          seed: s.seed,
          setups: s.setups,
          yourRobotId: s.localRobotId,
          ranked: s.ranked,
          intros: s.intros,
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
    navigate('game');
  };

  /** reconnect to and re-enter the match this browser last left (reclaims our held
   * server slot within its reconnect grace; fails cleanly to the "connection lost"
   * panel if the slot is already gone). */
  const rejoinGame = (ref: ActiveGameRef): void => {
    const params: Record<string, string> = { room: ref.room };
    if (ref.region) params.region = ref.region;
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
    transport.onOpen(() => transport.send(encodeMsg({ t: 'rejoin', room: ref.room, clientId: ref.clientId })));
    const s = new ServerSession(transport, false, ref.start, ref.clientId, ref.room);
    setSession(s);
    navigate('game');
  };

  const exitGame = (): void => {
    session?.dispose();
    setSession(null);
    // a match that FINISHED (or whose slot is gone) clears its rejoin record in
    // GameView; a mid-match exit keeps it so Home can offer "rejoin your match".
    setActiveGame(loadActiveGame());
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
  // set when the player tries to start a new game while one is already in progress —
  // drives the "you have a game in progress" overlay (rejoin or abandon)
  const [blockedByActive, setBlockedByActive] = useState(false);
  const guardStart = (go: () => void): void => {
    if (loadActiveGame()) setBlockedByActive(true);
    else if (restartPending) setStartBlocked(true);
    else if (newVersion) setPendingStart(() => go);
    else go();
  };

  /** abandon the in-progress game: forget it locally (its server slot then coasts +
   * drops after the grace) so the player is free to start something new. */
  const abandonActiveGame = (): void => {
    clearActiveGame();
    setActiveGame(null);
    setBlockedByActive(false);
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
        onSettingsChange={update}
        onStart={(s) => beginSession(s, 'custom')}
        onCancel={() => navigate('home')}
      />
    );
  }
  if (screen === 'record') {
    return (
      <RecordRun
        settings={settings}
        mode="solo"
        onStart={(s) => beginSession(s, 'record')}
        onCancel={() => navigate('home')}
        onPreferServer={(id) => update({ ...settings, preferredServerId: id })}
      />
    );
  }
  if (screen === 'duorecord') {
    return (
      <Lobby
        settings={settings}
        onSettingsChange={update}
        config={{ kind: 'record', record: 'duo' }}
        onStart={(s) => beginSession(s, 'record')}
        onCancel={() => navigate('home')}
      />
    );
  }
  if (screen === 'matchmaking') {
    return (
      <Matchmaking
        settings={settings}
        signedIn={signedIn}
        onStart={(s) => beginSession(s, 'ranked')}
        onCancel={() => navigate('home')}
        onSignIn={() => navigate('account')}
        onSettingsChange={update}
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
      {authEnabled && <UsernameGate />}
      {screen === 'home' && (
        <Home
          settings={settings}
          onChange={update}
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
          onEditRobot={() => navigate('robot')}
        />
      )}
      {blockedByActive && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>You’re already in a game</h2>
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              You can only be in one game at a time. Rejoin the one you’re in, or abandon it to
              start something new.
            </p>
            <div className="overlay-buttons">
              <button
                onClick={() => {
                  const ref = loadActiveGame();
                  setBlockedByActive(false);
                  if (ref) rejoinGame(ref);
                  else setActiveGame(null);
                }}
              >
                REJOIN
              </button>
              <button className="ghost" onClick={abandonActiveGame}>
                ABANDON
              </button>
            </div>
          </div>
        </div>
      )}
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
      {screen === 'robot' && <Menu settings={settings} onChange={update} />}
      {screen === 'leaderboard' && (
        <Leaderboard myUserId={accountUserId} onWatch={(id) => navigate('replay', id)} onOpenProfile={openProfile} />
      )}
      {screen === 'stats' && (
        <Stats onWatch={(id) => navigate('replay', id)} onOpenProfile={openProfile} />
      )}
      {screen === 'profile' && profileUser && (
        <Profile
          username={profileUser}
          nav={{ onWatch: (id) => navigate('replay', id), onOpenProfile: openProfile }}
        />
      )}
      {screen === 'download' && isAdmin && <Download />}
      {screen === 'account' && <Account settings={settings} onChange={update} />}
      {screen === 'admin' && isAdmin && <Admin />}
    </AppShell>
  );
}
