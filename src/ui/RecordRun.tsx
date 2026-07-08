import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl, gameServerUrlWith, multiServer, selectedServer, selectedServerId } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { RecordKind } from '../net/protocol';
import { ServerPicker } from './ServerPicker';

/**
 * Record-chasing launcher (opponent-free score attack). Unlike the custom-room
 * lobby, this is streamlined: connect → create a PRIVATE record room → auto-start
 * (the solo player is the room's host), then hand a ServerSession to the game.
 * The whole run executes on the authoritative server, so it's recorded + (if the
 * player is signed in) persisted to the leaderboard. Retries `start` while the
 * server's Rapier WASM is still loading after an auto-stop cold boot.
 */
export function RecordRun({
  settings,
  mode,
  onStart,
  onCancel,
  onPreferServer,
}: {
  settings: GameSettings;
  mode: RecordKind;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  /** persist the chosen server id to the account/settings (remember last choice) */
  onPreferServer?: (id: string) => void;
}) {
  const [status, setStatus] = useState('Connecting to the record server…');
  const [error, setError] = useState('');
  const startedRef = useRef(false);
  // show the server (region) picker BEFORE connecting when there's a choice; a
  // single-server deploy skips straight to connecting (confirmed = true).
  const [confirmed, setConfirmed] = useState(!multiServer());
  const [pick, setPick] = useState(selectedServerId());

  useEffect(() => {
    if (!confirmed) return;
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    const room = 'rec-' + Math.random().toString(36).slice(2, 9); // private, ephemeral
    // route to the picked region (one-app multi-region); solo, so no cross-region concern
    const region = selectedServer()?.region ?? '';
    const url = multiServer() && region ? gameServerUrlWith({ region }) : gameServerUrl();
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(url);
    } catch {
      setError('Could not reach the game server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    let tries = 0;
    let timer: number | undefined;

    const tryStart = (): void => {
      if (startedRef.current) return;
      lobby.start();
      // keep nudging: a cold-booted server refuses 'start' until physics is ready
      if (++tries < 25) timer = window.setTimeout(tryStart, 700);
      else setError('The server took too long to start. Try again.');
    };

    lobby.on('roster', () => {
      if (!startedRef.current && tries === 0) {
        setStatus('Starting your run…');
        tryStart();
      }
    });
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      if (timer) window.clearTimeout(timer);
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, room));
    });
    lobby.on('error', (msg) => {
      if (!/starting up/i.test(msg)) setError(msg); // startup ⇒ the retry loop handles it
    });
    lobby.on('closed', () => {
      if (!startedRef.current) setError('Lost connection to the game server.');
    });

    lobby.join(
      room,
      {
        name: settings.spec.teamName || 'Player',
        teamName: settings.spec.teamName,
        teamNumber: settings.spec.teamNumber,
        alliance: 'blue', // record runs are forced to one alliance server-side
        startIndex: settings.startIndex,
        ready: true,
        spec: settings.spec,
        assists: settings.assists,
      },
      { kind: 'record', record: mode },
    );

    return () => {
      if (timer) window.clearTimeout(timer);
      if (!startedRef.current) lobby.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed]);

  // pre-run server picker (only when there's more than one region to choose)
  if (!confirmed && !error) {
    return (
      <div className="ds-app">
        <main className="ds-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
          <div style={{ textAlign: 'center', maxWidth: 460 }}>
            <p className="ds-eyebrow">Record Run · {mode === 'duo' ? 'Duo 2v0' : 'Solo 1v0'}</p>
            <h1 className="ds-h1">Choose a server</h1>
            <p className="ds-sub" style={{ margin: '0 auto 16px' }}>
              Pick the region with the lowest ping. We’ll remember your choice.
            </p>
            <ServerPicker
              value={pick}
              onChange={(id) => {
                setPick(id);
                onPreferServer?.(id);
              }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="ds-btn ghost" onClick={onCancel}>← Back</button>
              <button className="ds-btn" onClick={() => setConfirmed(true)}>Start run →</button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="ds-app">
      <main className="ds-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 460 }}>
          <p className="ds-eyebrow">Record Run · {mode === 'duo' ? 'Duo 2v0' : 'Solo 1v0'}</p>
          {error ? (
            <>
              <h1 className="ds-h1">Couldn’t start</h1>
              <p className="ds-sub" style={{ margin: '0 auto 20px' }}>{error}</p>
            </>
          ) : (
            <>
              <h1 className="ds-h1">{status}</h1>
              <p className="ds-sub" style={{ margin: '0 auto 20px' }}>
                Your run records on the server for the leaderboard. First run after a quiet spell
                waits a few seconds for the server to wake.
              </p>
            </>
          )}
          <button className="ds-btn" onClick={onCancel}>← Back to Home</button>
        </div>
      </main>
    </div>
  );
}
