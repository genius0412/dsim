import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl, gameServerUrlWith, gameServerHttpUrl, multiServer } from '../net/env';
import { probeHome } from '../net/ping';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import { MatchStrategy } from './MatchStrategy';
import { usePresence } from './usePresence';
import { useServerNotice } from '../net/notice';

/**
 * Region-aware ranked matchmaking. We connect to the DESIGNATED matchmaker (a
 * `?mm=1` connection Fly routes to one region), report our home region + access
 * latency, and queue. Matchmaking is region-local first and WIDENS over time (or on
 * "Expand search"). On a match the server sends `matchAssigned` with a region-coded
 * room; we drop this socket and reconnect to `?room=…` (routed to the fair host
 * region) to actually play. On a single-region / no-DB dev server the server instead
 * sends `matchStart` straight back on this socket (handled too). ELO is applied
 * server-side on match end.
 */
/** the pre-match strategy window state, once a paired match opens one */
interface StrategyState {
  lobby: LobbyClient;
  players: LobbyPlayer[];
  myClientId: string;
  deadline: number;
  mode: QueueMode;
  intros: PlayerIntro[];
}

export function Matchmaking({
  settings,
  signedIn,
  onStart,
  onCancel,
  onSignIn,
  onSettingsChange,
}: {
  settings: GameSettings;
  signedIn: boolean;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  onSignIn: () => void;
  onSettingsChange: (s: GameSettings) => void;
}) {
  const [mode, setMode] = useState<QueueMode>('1v1');
  const [noWiden, setNoWiden] = useState(false);
  const presence = usePresence(); // live queue depths, refreshed while on this screen
  // block queueing while a server restart is scheduled (you'd only get dropped)
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState({ size: 0, need: 2 });
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  // set once a paired match opens its pre-match strategy window (see MatchStrategy)
  const [strategy, setStrategy] = useState<StrategyState | null>(null);

  const lobbyRef = useRef<LobbyClient | null>(null);
  const startedRef = useRef(false);
  const assigningRef = useRef(false); // reconnecting from matchmaker → host

  const teardown = (): void => {
    if (!startedRef.current) {
      lobbyRef.current?.leaveQueue();
      lobbyRef.current?.dispose();
    }
    lobbyRef.current = null;
  };
  useEffect(() => teardown, []); // cleanup on unmount

  useEffect(() => {
    if (!searching) return;
    let t = 0;
    const iv = window.setInterval(() => setElapsed(++t), 1000);
    return () => window.clearInterval(iv);
  }, [searching]);

  const playerInfo = () => ({
    name: settings.spec.teamName || 'Player',
    teamName: settings.spec.teamName,
    teamNumber: settings.spec.teamNumber,
    alliance: 'red' as const, // matchmaking assigns the real alliance
    startIndex: settings.startIndex,
    ready: false, // the pre-match strategy screen owns readiness now
    spec: settings.spec,
    assists: settings.assists,
  });

  /** attach the pre-match strategy handlers to a lobby socket (dev mm-socket path
   * AND the production reconnected host-room path both open a strategy window). */
  const wireStrategy = (lobby: LobbyClient): void => {
    lobby.on('roster', (players) =>
      setStrategy((s) => (s ? { ...s, players, myClientId: lobby.clientId } : s)),
    );
    lobby.on('strategyStart', (deadline, _yourRobotId, m, intros) =>
      setStrategy({
        lobby,
        players: lobby.players,
        myClientId: lobby.clientId,
        deadline,
        mode: m,
        intros,
      }),
    );
  };

  /** a cancel/close arrived (deadline lapsed, opponent left): drop the strategy
   * screen back to the queue with the reason shown. */
  const strategyCancelled = (msg: string): void => {
    setStrategy(null);
    setSearching(false);
    setError(msg);
  };

  const find = async (): Promise<void> => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    if (restartPending) {
      setError('Server is restarting shortly — try again in a minute.');
      return;
    }
    setError('');
    setElapsed(0);
    setSearching(true);
    // measure our home region + access latency (best-effort — the matchmaker falls
    // back to its own region if we can't report one)
    const home = await probeHome(gameServerHttpUrl());
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ mm: '1' }));
    } catch {
      setError('Could not reach the game server.');
      setSearching(false);
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    lobby.on('queued', (_m, size, need) => setQueue({ size, need }));
    // dev / single-region / no-DB: the strategy window + match run on this same socket
    wireStrategy(lobby);
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
    });
    // normal path: reconnect to the assigned host region to play
    lobby.on('matchAssigned', (room) => joinAssignedMatch(room));
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current && !assigningRef.current)
        setError('Lost connection to the game server.');
    });
    lobby.queue(mode, playerInfo(), home?.region ?? '', home?.accessMs ?? 0, noWiden);
  };

  /** a ranked match was assigned: drop the matchmaker socket and open a fresh one to
   * the region-coded room (fly-replay routes it to the fair host region). */
  const joinAssignedMatch = (room: string): void => {
    assigningRef.current = true;
    lobbyRef.current?.dispose();
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ room }));
    } catch {
      setError('Could not reach the match server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    wireStrategy(lobby);
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, room));
    });
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current) strategyCancelled('Lost connection to the match server.');
    });
    lobby.join(room, playerInfo());
  };

  const expand = (): void => lobbyRef.current?.expandSearch();

  const cancel = (): void => {
    teardown();
    setSearching(false);
  };

  // ranked requires an account (ELO / leaderboard). Custom rooms stay open to
  // everyone — the server also rejects an anonymous queue as a backstop.
  if (!signedIn) {
    return (
      <div className="ds-app">
        <main
          className="ds-main"
          style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}
        >
          <div style={{ textAlign: 'center', maxWidth: 460, width: '100%' }}>
            <p className="ds-eyebrow">Ranked</p>
            <h1 className="ds-h1">Sign in to play ranked</h1>
            <p className="ds-sub" style={{ margin: '0 auto 20px' }}>
              Ranked tracks ELO and the leaderboard, so it needs an account. Want to play now?
              Custom Rooms are open to everyone.
            </p>
            <button className="ds-btn primary" onClick={onSignIn}>
              Sign in
            </button>
            <div style={{ marginTop: 12 }}>
              <button className="ds-btn ghost" onClick={onCancel}>
                ← Home
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // a paired match opened its pre-match strategy window: take over the whole screen
  if (strategy) {
    return (
      <MatchStrategy
        lobby={strategy.lobby}
        players={strategy.players}
        myClientId={strategy.myClientId}
        deadline={strategy.deadline}
        mode={strategy.mode}
        intros={strategy.intros}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onLeave={() => {
          teardown();
          setStrategy(null);
          setSearching(false);
        }}
      />
    );
  }

  return (
    <div className="ds-app">
      <main className="ds-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 460, width: '100%' }}>
          <p className="ds-eyebrow">Ranked</p>
          <h1 className="ds-h1">{searching ? 'Finding a match…' : 'Ranked matchmaking'}</h1>
          {!searching ? (
            <>
              <p className="ds-sub" style={{ margin: '0 auto 20px' }}>
                Head-to-head ELO — the winner takes rating, split by drivetrain plus an overall
                board. Sign in for it to count.
              </p>
              <div className="ds-segs" style={{ justifyContent: 'center', marginBottom: 12 }}>
                <button className={`ds-seg ${mode === '1v1' ? 'on' : ''}`} onClick={() => setMode('1v1')}>1v1</button>
                <button className={`ds-seg ${mode === '2v2' ? 'on' : ''}`} onClick={() => setMode('2v2')}>2v2</button>
              </div>
              <p className="ds-sub" style={{ margin: '0 auto 20px', fontSize: 13 }}>
                {presence ? (
                  <>
                    <b style={{ color: 'var(--ds-ink)' }}>{presence.queues[mode]}</b> waiting in{' '}
                    {mode.toUpperCase()} ·{' '}
                    {presence.queues[mode === '1v1' ? '2v2' : '1v1']} in{' '}
                    {(mode === '1v1' ? '2v2' : '1v1').toUpperCase()} · {presence.online} online
                  </>
                ) : (
                  <span style={{ opacity: 0.6 }}>Checking who’s online…</span>
                )}
              </p>
              {multiServer() && (
                <div className="ds-opts" style={{ marginBottom: 16 }}>
                  <button
                    className={`ds-opt ${noWiden ? 'on' : ''}`}
                    onClick={() => setNoWiden(!noWiden)}
                  >
                    <span className="ot">Only my region {noWiden ? 'ON' : 'OFF'}</span>
                    <span className="od">Never widen the search — lowest ping, may wait longer</span>
                  </button>
                </div>
              )}
              {error && <p className="ds-form-err" style={{ marginBottom: 12 }}>{error}</p>}
              {restartPending && (
                <p className="ds-form-err" style={{ marginBottom: 12 }}>
                  Server is restarting shortly — queueing is paused for a moment.
                </p>
              )}
              <button className="ds-btn primary" disabled={restartPending} onClick={() => void find()}>
                Find Match
              </button>
              <div style={{ marginTop: 12 }}>
                <button className="ds-btn ghost" onClick={onCancel}>← Home</button>
              </div>
            </>
          ) : (
            <>
              <p className="ds-sub" style={{ margin: '0 auto 8px' }}>
                {mode.toUpperCase()} · {queue.size}/{queue.need} in queue · {elapsed}s
              </p>
              {/* region-local first; widen automatically as you wait, or on demand */}
              {!noWiden && multiServer() && (
                <p className="ds-sub" style={{ margin: '0 auto 16px', fontSize: 13, opacity: 0.75 }}>
                  {elapsed < 8
                    ? 'Searching your region…'
                    : 'Widening search to nearby regions…'}
                </p>
              )}
              {error && <p className="ds-form-err" style={{ marginBottom: 12 }}>{error}</p>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {!noWiden && multiServer() && (
                  <button className="ds-btn" onClick={expand}>Expand search</button>
                )}
                <button className="ds-btn" onClick={cancel}>Cancel</button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
