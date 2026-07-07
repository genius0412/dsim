import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { QueueMode } from '../net/protocol';
import { usePresence } from './usePresence';

/**
 * Ranked matchmaking. Pick a bracket (1v1 / 2v2), enter the server queue, and when
 * it fills the server assigns a room + sends `matchStart` — handed to a
 * ServerSession exactly like a custom room. ELO is applied server-side on match
 * end (sign in for it to count).
 */
export function Matchmaking({
  settings,
  signedIn,
  onStart,
  onCancel,
  onSignIn,
}: {
  settings: GameSettings;
  signedIn: boolean;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  onSignIn: () => void;
}) {
  const [mode, setMode] = useState<QueueMode>('1v1');
  const presence = usePresence(); // live queue depths, refreshed while on this screen
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState({ size: 0, need: 2 });
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const lobbyRef = useRef<LobbyClient | null>(null);
  const startedRef = useRef(false);

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

  const find = (): void => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    setError('');
    setElapsed(0);
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrl());
    } catch {
      setError('Could not reach the game server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    lobby.on('queued', (_m, size, need) => setQueue({ size, need }));
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
    });
    lobby.on('error', (msg) => setError(msg));
    lobby.on('closed', () => {
      if (!startedRef.current) setError('Lost connection to the game server.');
    });
    lobby.queue(mode, {
      name: settings.spec.teamName || 'Player',
      teamName: settings.spec.teamName,
      teamNumber: settings.spec.teamNumber,
      alliance: 'red', // matchmaking assigns the real alliance
      startIndex: settings.startIndex,
      ready: true,
      spec: settings.spec,
      assists: settings.assists,
    });
    setSearching(true);
  };

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
              {error && <p className="ds-form-err" style={{ marginBottom: 12 }}>{error}</p>}
              <button className="ds-btn primary" onClick={find}>Find Match</button>
              <div style={{ marginTop: 12 }}>
                <button className="ds-btn ghost" onClick={onCancel}>← Home</button>
              </div>
            </>
          ) : (
            <>
              <p className="ds-sub" style={{ margin: '0 auto 16px' }}>
                {mode.toUpperCase()} · {queue.size}/{queue.need} in queue · {elapsed}s
              </p>
              {error && <p className="ds-form-err" style={{ marginBottom: 12 }}>{error}</p>}
              <button className="ds-btn" onClick={cancel}>Cancel</button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
